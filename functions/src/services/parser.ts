import Anthropic from "@anthropic-ai/sdk";
import { EVENT_CATEGORIES, ScrapedEvent } from "../scrapers/base.js";
import { EXTRACTION_MODEL, EXTRACTION_PROMPT } from "./extractionPrompt.js";
import type { ExtractionCache, NewItems } from "./extractionCache.js";
import { addDays, etTimestamp, type DateParts } from "./etTime.js";
import { resolveEventbriteUrl } from "./eventUrl.js";
import { temporalExclusionReason } from "./temporalFilter.js";


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
export function parseEventTimes(date: string, startTime: string, endTime: string): {
  startTimestamp: number; endTimestamp: number;
} {
  const parts = parseDate(date);
  const start = parseTime(startTime, "12:00");
  const end = parseTime(endTime, "23:59");
  const startDay = addDays(parts, start.hour === 24 ? 1 : 0);
  const startWallMinutes = start.hour * 60 + start.minute;
  let endWallMinutes = end.hour * 60 + end.minute;
  // Choose the calendar day before converting the end instant: a same-date
  // DST gap may be irrelevant when this clock actually belongs to tomorrow.
  // Equal clocks retain the existing next-day convention, including 24:00.
  while (endWallMinutes <= startWallMinutes) endWallMinutes += 24 * 60;
  const endDay = addDays(parts, Math.floor(endWallMinutes / (24 * 60)));
  const startTimestamp = etTimestamp(startDay.year, startDay.month, startDay.day, start.hour % 24, start.minute);
  const endTimestamp = etTimestamp(endDay.year, endDay.month, endDay.day, end.hour % 24, end.minute);
  return { startTimestamp, endTimestamp };
}

// Invalid model output is an extraction failure, not a successful empty page.
// Validate decisions before the temporal filter so malformed candidates cannot
// be silently excluded and then remembered as successfully extracted.
export function parseExtractionResponse(text: string): ExtractedEvent[] {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new Error("Failed to parse extraction JSON");
  }
  if (!Array.isArray(value)) throw new Error("Extraction response was not an array");
  const fields = ["title", "description", "date", "startTime", "endTime", "location", "category", "temporalStatus", "temporalEvidence"];
  return value.map((candidate: unknown, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`Invalid extraction item ${index}`);
    const record = candidate as Record<string, unknown>;
    for (const field of fields) {
      if (typeof record[field] !== "string") throw new Error(`Extraction item ${index}: ${field} must be a string`);
    }
    if (record.url !== undefined && typeof record.url !== "string") throw new Error(`Extraction item ${index}: url must be a string`);
    const event = candidate as ExtractedEvent;
    if (!event.title.trim() || !event.temporalEvidence.trim()) throw new Error(`Extraction item ${index}: missing title or temporal evidence`);
    if (!["scheduled_event", "limited_run", "permanent_attraction"].includes(event.temporalStatus)) {
      throw new Error(`Extraction item ${index}: invalid temporalStatus`);
    }
    if (!(EVENT_CATEGORIES as readonly string[]).includes(event.category)) throw new Error(`Extraction item ${index}: invalid category`);
    if (event.temporalStatus !== "permanent_attraction") {
      if (!event.location.trim()) throw new Error(`Extraction item ${index}: missing location`);
      parseEventTimes(event.date, event.startTime, event.endTime);
    }
    return event;
  });
}

async function resolveVagueLocations(
  events: ExtractedEvent[],
  client: Anthropic
): Promise<ExtractedEvent[]> {
  const vagueEvents = events.filter((e) => isVagueLocation(e.location));
  if (vagueEvents.length === 0) return events;

  const specificEvents = events.filter((e) => !isVagueLocation(e.location));

  // Ask Claude to resolve each vague location
  for (const event of vagueEvents) {
    try {
      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: `An event called "${event.title}" is described as being at "${event.location}" in New York City.

Based on your knowledge, what are the specific locations (venue names and addresses) where this takes place in NYC? If this is a brand, business, or chain, list their NYC locations.

Return ONLY a JSON array of location strings. Each string should be a specific venue name and address. If you don't know the specific locations, return an empty array [].

Example: ["Joe's Pizza, 7 Carmine St, New York, NY", "Joe's Pizza, 150 E 14th St, New York, NY"]`,
          },
        ],
      });

      const text = message.content[0].type === "text" ? message.content[0].text : "";
      const cleaned = text.replace(/```(?:json)?\s*/gi, "").trim();

      let locations: unknown;
      try {
        locations = JSON.parse(cleaned);
      } catch {
        throw new Error(`Failed to parse locations for "${event.title}"`);
      }
      if (!Array.isArray(locations) || locations.some((loc) => typeof loc !== "string" || !loc.trim())) {
        throw new Error(`Invalid location response for "${event.title}"`);
      }
      if (locations.length === 0) {
        console.log(`No specific locations found for "${event.title}", skipping`);
        continue;
      }

      console.log(`Resolved "${event.title}" to ${locations.length} locations`);
      for (const loc of locations) {
        specificEvents.push({ ...event, location: loc as string });
      }
    } catch (err) {
      // A failed resolution must not stage the source item as a success.
      throw new Error(`Location resolution failed for "${event.title}"`, { cause: err });
    }
  }

  return specificEvents;
}

// Failures are thrown so the source run cannot report a healthy empty result.
async function extractEvents(
  content: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string
): Promise<ScrapedEvent[]> {
  if (content.length > MAX_EXTRACTION_CONTENT_CHARS) throw new Error("Extraction content exceeds the input limit");
  const client = new Anthropic({ apiKey, timeout: 10 * 60 * 1000 });
  console.log(`Content sent: ${content.length} chars`);

  let message;
  try {
    message = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 32768,
      messages: [
        {
          role: "user",
          content: `${EXTRACTION_PROMPT}\n\nPage content:\n${content}`,
        },
      ],
    });
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
  const parsed = parseExtractionResponse(text);

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
  const resolvedEvents = await resolveVagueLocations(temporalEvents, client);

  return Promise.all(resolvedEvents.map(async (e) => {
    const { startTimestamp, endTimestamp } = parseEventTimes(e.date, e.startTime, e.endTime);
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
    const resolvedSourceUrl =
      (await resolveEventbriteUrl(e.title || "Untitled Event", candidateSourceUrl)) || sourceUrl;

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

type ExtractItems = (content: string, sourceName: string, sourceUrl: string, apiKey: string) => Promise<ScrapedEvent[]>;

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
  for (const batch of batches) {
    const text = batch.texts.join(ITEM_SEPARATOR);
    console.log(`Sending ${batch.items.length} ${cache.sourceName} items to Claude (${text.length} chars)`);
    events.push(...await (options.extract ?? extractEvents)(text, cache.sourceName, sourceUrl, apiKey));
  }
  cache.stage(fresh.keys);
  return { items: fresh.items, events };
}
