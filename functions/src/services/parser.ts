import Anthropic from "@anthropic-ai/sdk";
import { EVENT_CATEGORIES, type EventCategory, ScrapedEvent } from "../scrapers/base.js";
import { EXTRACTION_MODEL, EXTRACTION_PROMPT } from "./extractionPrompt.js";
import type { ExtractionCache, NewItems } from "./extractionCache.js";
import { addDays, etTimestamp, type DateParts } from "./etTime.js";
import { resolveEventbriteUrl } from "./eventUrl.js";
import { forcedToolInput } from "./llmTools.js";
import { temporalExclusionReason } from "./temporalFilter.js";

// A batch that produced usable events but not a complete, trustworthy result
// (one malformed candidate, an unresolved venue, a failed link lookup) is
// reported here. Its events are still delivered, but its source items are not
// marked as extracted, so the next run extracts them again.
export interface ExtractionReport {
  partial(reason: string): void;
}


export function stripHtml(html: string): string {
  // Extract JSON-LD blocks (structured data) before stripping
  const jsonLdBlocks: string[] = [];
  const jsonLdRegex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    jsonLdBlocks.push(match[1]);
  }

  let cleaned = html;

  // Remove <script> tags and contents (except JSON-LD already extracted)
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Remove <style> tags and contents
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Remove <link>, <meta>, <noscript> tags
  cleaned = cleaned.replace(/<(link|meta|noscript)[^>]*\/?>/gi, "");
  cleaned = cleaned.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");

  // Remove SVG blocks
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, "");

  // Preserve links: convert <a href="url">text</a> to text (url)
  cleaned = cleaned.replace(
    /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `${text.replace(/<[^>]+>/g, "")} (${href})`
  );

  // Remove all remaining HTML tags, keep text content
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Prepend JSON-LD data if found
  if (jsonLdBlocks.length > 0) {
    const jsonLdSection = "STRUCTURED DATA:\n" + jsonLdBlocks.join("\n") + "\n\nPAGE CONTENT:\n";
    cleaned = jsonLdSection + cleaned;
  }

  return cleaned;
}

const VAGUE_LOCATION_PATTERNS = [
  /multiple\s+(locations?|venues?|spots?|places?)/i,
  /various\s+(locations?|venues?|spots?|places?)/i,
  /several\s+(locations?|venues?|spots?|places?)/i,
  /different\s+(locations?|venues?|spots?|places?)/i,
  /locations?\s+across/i,
  /see\s+(website|site|link)/i,
  /check\s+(website|site|link)/i,
  /tba|tbd/i,
];

function isVagueLocation(location: string): boolean {
  if (!location || location.length < 3) return true;
  return VAGUE_LOCATION_PATTERNS.some((p) => p.test(location));
}

export interface ExtractedEvent {
  title: string;
  description: string;
  date: string;
  endDate?: string;
  startTime: string;
  endTime: string;
  location: string;
  category: string;
  url?: string;
  temporalStatus: "scheduled_event" | "limited_run" | "permanent_attraction";
  temporalEvidence: string;
}

function parseDate(date: string): DateParts {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid extraction date: ${date}`);
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day) {
    throw new Error(`Invalid extraction date: ${date}`);
  }
  return parts;
}

function parseTime(time: string, fallback: string): { hour: number; minute: number } {
  const match = (time || fallback).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid extraction time: ${time}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new Error(`Invalid extraction time: ${time}`);
  }
  return { hour, minute };
}

// Convert each endpoint separately: an overnight event can cross a DST change.
export function parseEventTimes(date: string, startTime: string, endTime: string, endDate?: string): {
  startTimestamp: number; endTimestamp: number;
} {
  const parts = parseDate(date);
  const finalParts = endDate ? parseDate(endDate) : parts;
  const days = (Date.UTC(finalParts.year, finalParts.month - 1, finalParts.day) -
    Date.UTC(parts.year, parts.month - 1, parts.day)) / 86_400_000;
  if (days < 0) throw new Error("Extraction end date is before start date");
  const start = parseTime(startTime, "12:00");
  const end = parseTime(endTime, "23:59");
  const startDay = addDays(parts, start.hour === 24 ? 1 : 0);
  const startWallMinutes = start.hour * 60 + start.minute;
  let endWallMinutes = days * 24 * 60 + end.hour * 60 + end.minute;
  // Preserve the final calendar date of a continuous run. The overnight
  // convention applies only when its end clock would otherwise precede start.
  while (endWallMinutes <= startWallMinutes) endWallMinutes += 24 * 60;
  const endDay = addDays(parts, Math.floor(endWallMinutes / (24 * 60)));
  const startTimestamp = etTimestamp(startDay.year, startDay.month, startDay.day, start.hour % 24, start.minute);
  const endTimestamp = etTimestamp(endDay.year, endDay.month, endDay.day, end.hour % 24, end.minute);
  return { startTimestamp, endTimestamp };
}

const EXTRACTED_FIELDS = ["title", "description", "date", "startTime", "endTime", "location", "category", "temporalStatus", "temporalEvidence"];

function validateCandidate(candidate: unknown, index: number): ExtractedEvent {
  if (!candidate || typeof candidate !== "object") throw new Error(`Invalid extraction item ${index}`);
  const record = candidate as Record<string, unknown>;
  for (const field of EXTRACTED_FIELDS) {
    if (typeof record[field] !== "string") throw new Error(`Extraction item ${index}: ${field} must be a string`);
  }
  if (record.url !== undefined && typeof record.url !== "string") throw new Error(`Extraction item ${index}: url must be a string`);
  if (record.endDate !== undefined && typeof record.endDate !== "string") throw new Error(`Extraction item ${index}: endDate must be a string`);
  const event = candidate as ExtractedEvent;
  if (!event.title.trim() || !event.temporalEvidence.trim()) throw new Error(`Extraction item ${index}: missing title or temporal evidence`);
  if (!["scheduled_event", "limited_run", "permanent_attraction"].includes(event.temporalStatus)) {
    throw new Error(`Extraction item ${index}: invalid temporalStatus`);
  }
  if (!(EVENT_CATEGORIES as readonly string[]).includes(event.category)) throw new Error(`Extraction item ${index}: invalid category`);
  if (event.temporalStatus !== "permanent_attraction") {
    if (!event.location.trim()) throw new Error(`Extraction item ${index}: missing location`);
    if (event.temporalStatus === "limited_run" && !event.endDate?.trim()) {
      throw new Error(`Extraction item ${index}: limited run is missing its final date`);
    }
    parseEventTimes(event.date, event.startTime, event.endTime, event.endDate);
  }
  return event;
}

function parseCandidates(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new Error("Failed to parse extraction JSON");
  }
  if (!Array.isArray(value)) throw new Error("Extraction response was not an array");
  return value;
}

// Invalid model output is an extraction failure, not a successful empty page.
// Validate decisions before the temporal filter so malformed candidates cannot
// be silently excluded and then remembered as successfully extracted.
export function parseExtractionResponse(text: string): ExtractedEvent[] {
  return parseCandidates(text).map(validateCandidate);
}

const CATEGORY_ALIASES: Record<string, EventCategory> = {
  "pop up": "popup", "pop ups": "popup", "popups": "popup", "pop up shop": "popup",
  "free": "free_stuff", "freebie": "free_stuff", "freebies": "free_stuff", "giveaway": "free_stuff", "giveaways": "free_stuff",
  "bar": "bars", "club": "clubs", "nightclub": "clubs", "nightclubs": "clubs",
  "concert": "concerts", "live music": "concerts",
  "farmers markets": "farmers_market", "greenmarket": "farmers_market", "greenmarkets": "farmers_market",
  "street fairs": "street_fair", "street festival": "street_fair", "block party": "street_fair",
  "trick or treating": "trick_or_treat", "trick or streets": "trick_or_treat",
  "happenings": "happening",
};
const categoryKey = (value: string) => value.toLowerCase().replace(/['’]/g, "").replace(/[^a-z]+/g, " ").trim();
const CANONICAL_CATEGORIES = new Map(EVENT_CATEGORIES.map((category) => [categoryKey(category), category]));

// Maps a category label to its canonical value ("Pop-Up" → popup, "farmer's
// market" → farmers_market), or null when the label is not a known one.
export function normalizeCategory(value: unknown): EventCategory | null {
  if (typeof value !== "string") return null;
  const key = categoryKey(value);
  return CANONICAL_CATEGORIES.get(key) ?? CATEGORY_ALIASES[key] ?? null;
}

export interface ExtractionPartition {
  events: ExtractedEvent[];
  rejected: string[];
}

// The batch-level counterpart of parseExtractionResponse. The response must
// still be a JSON array, and each candidate is validated exactly as strictly,
// but one malformed candidate is reported instead of discarding its valid
// siblings. A category label outside the list is a display grouping, not a
// safety decision, so it falls back to the prompt's catch-all ("happening").
export function partitionExtractionResponse(text: string): ExtractionPartition {
  const result: ExtractionPartition = { events: [], rejected: [] };
  parseCandidates(text).forEach((candidate, index) => {
    let normalized = candidate;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (typeof record.category === "string" && !(EVENT_CATEGORIES as readonly string[]).includes(record.category)) {
        const category = normalizeCategory(record.category) ?? "happening";
        console.log(`Extraction item ${index}: category "${record.category}" → "${category}"`);
        normalized = { ...record, category };
      }
    }
    try {
      result.events.push(validateCandidate(normalized, index));
    } catch (error) {
      result.rejected.push(error instanceof Error ? error.message : String(error));
    }
  });
  return result;
}

function readExtraction(text: string): ExtractionPartition | Error {
  try {
    return partitionExtractionResponse(text);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function lookupVenueLocations(client: Anthropic, event: ExtractedEvent): Promise<string[]> {
  const input = await forcedToolInput(client, {
    model: "claude-haiku-4-5-20251001",
    maxTokens: 2048,
    prompt: `An event called "${event.title}" is described as being at "${event.location}" in New York City.

Based on your knowledge, what are the specific locations (venue names and addresses) where this takes place in NYC? If this is a brand, business, or chain, list their NYC locations.

Report them with the report_locations tool. Each location must be a specific venue name and street address, for example "Joe's Pizza, 7 Carmine St, New York, NY". If you don't know the specific locations, report an empty list.`,
    tool: {
      name: "report_locations",
      description: "Report the specific NYC venue names and street addresses for the event, or an empty list if they are unknown.",
      schema: {
        properties: {
          locations: { type: "array", items: { type: "string" }, description: "Specific NYC venue names with street addresses." },
        },
        required: ["locations"],
      },
    },
  });
  const locations = input.locations;
  if (!Array.isArray(locations) || locations.some((loc) => typeof loc !== "string" || !loc.trim())) {
    throw new Error(`Invalid location response for "${event.title}"`);
  }
  return locations as string[];
}

async function resolveVagueLocations(
  events: ExtractedEvent[],
  client: Anthropic,
  report?: ExtractionReport
): Promise<ExtractedEvent[]> {
  const vagueEvents = events.filter((e) => isVagueLocation(e.location));
  if (vagueEvents.length === 0) return events;

  const specificEvents = events.filter((e) => !isVagueLocation(e.location));

  // Ask Claude to resolve each vague location
  for (const event of vagueEvents) {
    let locations: string[];
    try {
      locations = await lookupVenueLocations(client, event);
    } catch (err) {
      // A failed resolution must not stage the source item as a success. With
      // a report, only this event is held back; its siblings still publish.
      if (!report) throw new Error(`Location resolution failed for "${event.title}"`, { cause: err });
      report.partial(`Location resolution failed for "${event.title}": ${String(err)}`);
      continue;
    }
    if (locations.length === 0) {
      console.log(`No specific locations found for "${event.title}", skipping`);
      continue;
    }

    console.log(`Resolved "${event.title}" to ${locations.length} locations`);
    for (const loc of locations) {
      specificEvents.push({ ...event, location: loc });
    }
  }

  return specificEvents;
}

async function requestExtraction(client: Anthropic, content: string): Promise<string> {
  let message;
  try {
    // Receive long JSON outputs incrementally so proxies do not close an idle
    // connection. Validate only the fully aggregated message, never a fragment.
    message = await client.messages.stream({
      model: EXTRACTION_MODEL,
      max_tokens: 32768,
      messages: [
        {
          role: "user",
          content: `${EXTRACTION_PROMPT}\n\nPage content:\n${content}`,
        },
      ],
    }).finalMessage();
  } catch (err) {
    console.error("Claude API call failed:", err);
    throw err;
  }

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  console.log("Claude response length:", text.length, "stop_reason:", message.stop_reason);
  console.log("Response start:", text.slice(0, 200));
  console.log("Response end:", text.slice(-200));

  if (message.stop_reason === "max_tokens") throw new Error("Extraction response exceeded the output limit");
  if (!message.stop_reason) throw new Error("Extraction stream ended before completion");
  return text;
}

// Failures are thrown so the source run cannot report a healthy empty result.
// Model output is nondeterministic, so a malformed response gets one fresh
// attempt. A candidate that is still malformed is reported (and its batch is
// extracted again next run) instead of discarding every valid sibling; without
// a report to record that, the batch fails as before.
export async function extractEvents(
  content: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string,
  options: { client?: Anthropic; report?: ExtractionReport } = {}
): Promise<ScrapedEvent[]> {
  if (content.length > MAX_EXTRACTION_CONTENT_CHARS) throw new Error("Extraction content exceeds the input limit");
  const client = options.client ?? new Anthropic({ apiKey, timeout: 10 * 60 * 1000 });
  const report = options.report;
  console.log(`Content sent: ${content.length} chars`);

  let attempt = readExtraction(await requestExtraction(client, content));
  if (attempt instanceof Error || attempt.rejected.length > 0) {
    console.warn(`Invalid extraction output (${attempt instanceof Error ? attempt.message : attempt.rejected.join("; ")}); retrying once`);
    const retry = readExtraction(await requestExtraction(client, content));
    if (!(retry instanceof Error) && (attempt instanceof Error || retry.rejected.length <= attempt.rejected.length)) {
      attempt = retry;
    }
  }
  if (attempt instanceof Error) throw attempt;
  if (attempt.rejected.length > 0) {
    if (!report) throw new Error(attempt.rejected[0]);
    for (const reason of attempt.rejected) report.partial(reason);
  }
  const parsed = attempt.events;

  // The extractor must make an explicit temporal-vs-permanent decision for
  // every candidate. Fail closed when that decision or its source evidence is
  // absent: a dated admission slot for a permanent attraction is not an event.
  const temporalEvents = parsed.filter((event) => {
    const reason = temporalExclusionReason(event);
    if (!reason) return true;
    console.log(`Skipped non-temporal candidate (${reason})`);
    return false;
  });
  console.log(
    `Temporal filter: ${temporalEvents.length}/${parsed.length} candidates kept`
  );

  // Resolve locations only after the temporal gate so permanent attractions do
  // not trigger extra model calls.
  const resolvedEvents = sourceName === "nycforfree"
    ? temporalEvents // The scraper overlays the source's actual addresses/pins; do not guess chain locations.
    : await resolveVagueLocations(temporalEvents, client, report);

  return Promise.all(resolvedEvents.map(async (e) => {
    const { startTimestamp, endTimestamp } = parseEventTimes(e.date, e.startTime, e.endTime, e.endDate);
    console.log(`Parsed event: "${e.title}" date=${e.date} start=${e.startTime} end=${e.endTime} startTs=${startTimestamp} endTs=${endTimestamp} category=${e.category}`);

    let candidateSourceUrl = sourceUrl;
    if (e.url) {
      if (e.url.startsWith("/")) {
        try {
          candidateSourceUrl = `${new URL(sourceUrl).origin}${e.url}`;
        } catch {
          candidateSourceUrl = sourceUrl;
        }
      } else {
        candidateSourceUrl = e.url;
      }
    }
    let resolvedSourceUrl: string;
    try {
      resolvedSourceUrl = (await resolveEventbriteUrl(e.title || "Untitled Event", candidateSourceUrl)) || sourceUrl;
    } catch (error) {
      // Eventbrite search can refuse datacenter traffic. Publish the event
      // with the listing link and retry its deep link on the next run.
      if (!report) throw error;
      report.partial(String(error));
      resolvedSourceUrl = sourceUrl;
    }

    return {
      title: e.title || "Untitled Event",
      description: e.description || "",
      startTimestamp,
      endTimestamp,
      location: e.location || "",
      category: ((EVENT_CATEGORIES as readonly string[]).includes(e.category) ? e.category : "happening") as ScrapedEvent["category"],
      sourceUrl: resolvedSourceUrl,
      sourceName,
      temporalStatus: e.temporalStatus as ScrapedEvent["temporalStatus"],
      temporalEvidence: e.temporalEvidence!.trim(),
    };
  }));
}

const ITEM_SEPARATOR = "\n\n---\n\n";
export const MAX_EXTRACTION_CONTENT_CHARS = 100_000;

type ExtractItems = (content: string, sourceName: string, sourceUrl: string, apiKey: string, report?: ExtractionReport) => Promise<ScrapedEvent[]>;

const extractWithReport: ExtractItems = (content, sourceName, sourceUrl, apiKey, report) =>
  extractEvents(content, sourceName, sourceUrl, apiKey, { report });

function batchItems<T>(fresh: NewItems<T>): NewItems<T>[] {
  // Check all items first, before any model call or successful-key staging.
  if (fresh.texts.some((text) => text.length > MAX_EXTRACTION_CONTENT_CHARS)) {
    throw new Error("An extraction item exceeds the input limit");
  }
  const batches: NewItems<T>[] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < fresh.texts.length; i++) {
    const added = fresh.texts[i].length + (i > start ? ITEM_SEPARATOR.length : 0);
    if (size + added > MAX_EXTRACTION_CONTENT_CHARS) {
      batches.push({ items: fresh.items.slice(start, i), texts: fresh.texts.slice(start, i), keys: fresh.keys.slice(start, i) });
      start = i;
      size = 0;
    }
    size += fresh.texts[i].length + (i > start ? ITEM_SEPARATOR.length : 0);
  }
  if (start < fresh.items.length) {
    batches.push({ items: fresh.items.slice(start), texts: fresh.texts.slice(start), keys: fresh.keys.slice(start) });
  }
  return batches;
}

// Each batch contains whole source items, never a truncated tail. Keys are
// staged only after all batches succeed; malformed output throws to the source
// caller rather than poisoning the cache or being counted as a healthy zero.
// A batch whose extraction was only partly usable still delivers its events,
// but its keys stay unstaged so those items are extracted again next run.
export async function parseNewItems<T>(
  items: T[],
  toText: (item: T) => string,
  cache: ExtractionCache,
  sourceUrl: string,
  apiKey: string,
  options: { extract?: ExtractItems } = {}
): Promise<{ items: T[]; events: ScrapedEvent[] }> {
  const fresh = await cache.filterNew(items, toText);
  const batches = batchItems(fresh);
  const events: ScrapedEvent[] = [];
  const completeKeys: string[] = [];
  for (const batch of batches) {
    const text = batch.texts.join(ITEM_SEPARATOR);
    console.log(`Sending ${batch.items.length} ${cache.sourceName} items to Claude (${text.length} chars)`);
    const problems: string[] = [];
    const report: ExtractionReport = { partial: (reason) => { problems.push(reason); } };
    events.push(...await (options.extract ?? extractWithReport)(text, cache.sourceName, sourceUrl, apiKey, report));
    if (problems.length === 0) {
      completeKeys.push(...batch.keys);
      continue;
    }
    const shown = problems.slice(0, 3).join("; ");
    cache.recordFailure(`${batch.items.length} item(s) will be extracted again: ${shown}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
  }
  cache.stage(completeKeys);
  return { items: fresh.items, events };
}
