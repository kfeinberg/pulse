import Anthropic from "@anthropic-ai/sdk";
import { ScrapedEvent } from "../scrapers/base.js";
import { EXTRACTION_PROMPT } from "./extractionPrompt.js";
import { resolveEventbriteUrl } from "./eventUrl.js";


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

async function resolveVagueLocations(
  events: Array<{
    title: string;
    description: string;
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    category: string;
    url?: string;
  }>,
  client: Anthropic
): Promise<typeof events> {
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

      let locations: string[];
      try {
        locations = JSON.parse(cleaned);
      } catch {
        console.warn(`Failed to parse locations for "${event.title}":`, text);
        specificEvents.push(event);
        continue;
      }

      if (!Array.isArray(locations) || locations.length === 0) {
        console.log(`No specific locations found for "${event.title}", skipping`);
        continue;
      }

      console.log(`Resolved "${event.title}" to ${locations.length} locations`);
      for (const loc of locations) {
        specificEvents.push({ ...event, location: loc });
      }
    } catch (err) {
      console.warn(`Location resolution failed for "${event.title}":`, err);
      specificEvents.push(event);
    }
  }

  return specificEvents;
}

async function sendToClaude(
  content: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string
): Promise<ScrapedEvent[]> {
  const client = new Anthropic({ apiKey, timeout: 10 * 60 * 1000 });

  const truncatedContent = content.slice(0, 100_000);
  console.log(
    `Content: ${content.length} chars → sent: ${truncatedContent.length} chars`
  );

  let message;
  try {
    message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 32768,
      messages: [
        {
          role: "user",
          content: `${EXTRACTION_PROMPT}\n\nPage content:\n${truncatedContent}`,
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

  // Strip markdown fences if present
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").trim();

  let parsed: Array<{
    title: string;
    description: string;
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    category: string;
    url?: string;
  }>;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("Failed to parse Claude response:", text);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error("Claude response was not an array:", parsed);
    return [];
  }

  // Second pass: resolve vague multi-location events
  const resolvedEvents = await resolveVagueLocations(parsed, client);

  return Promise.all(resolvedEvents.map(async (e) => {
    const dateStr = e.date || new Date().toISOString().split("T")[0];
    // Normalize time strings: handle "24:00" -> "00:00", ensure HH:MM format
    const normalizeTime = (t: string, fallback: string): string => {
      if (!t) return fallback;
      const cleaned = t.replace(/^24:/, "00:");
      // Ensure it matches HH:MM
      if (/^\d{1,2}:\d{2}$/.test(cleaned)) {
        const [h, m] = cleaned.split(":");
        return `${h.padStart(2, "0")}:${m}`;
      }
      return fallback;
    };
    const startTimeStr = normalizeTime(e.startTime, "12:00");
    const endTimeStr = normalizeTime(e.endTime, "23:59");
    // Determine if date is in EDT (Mar-Nov) or EST (Nov-Mar)
    const testDate = new Date(`${dateStr}T12:00:00Z`);
    const month = testDate.getUTCMonth(); // 0-indexed
    const isDST = month >= 2 && month <= 10; // rough EDT: Mar–Oct
    const tzOffset = isDST ? "-04:00" : "-05:00";
    // Parse times as Eastern Time
    let startTimestamp = new Date(`${dateStr}T${startTimeStr}:00${tzOffset}`).getTime();
    let endTimestamp = new Date(`${dateStr}T${endTimeStr}:00${tzOffset}`).getTime();
    // Guard against NaN timestamps
    if (isNaN(startTimestamp)) {
      console.warn(`Invalid start timestamp for "${e.title}": date=${dateStr} time=${e.startTime}, using noon`);
      startTimestamp = new Date(`${dateStr}T12:00:00${tzOffset}`).getTime();
    }
    if (isNaN(endTimestamp)) {
      console.warn(`Invalid end timestamp for "${e.title}": date=${dateStr} time=${e.endTime}, using 23:59`);
      endTimestamp = new Date(`${dateStr}T23:59:00${tzOffset}`).getTime();
    }
    // If end time is before start time, the event crosses midnight — bump end to next day
    if (endTimestamp <= startTimestamp) {
      const nextDay = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      endTimestamp = new Date(`${nextDay}T${endTimeStr}:00${tzOffset}`).getTime();
    }
    console.log(`Parsed event: "${e.title}" date=${dateStr} start=${startTimeStr} end=${endTimeStr} startTs=${startTimestamp} endTs=${endTimestamp} category=${e.category}`);

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
      category: (["popup", "free_stuff", "happening", "bars", "clubs", "concerts"].includes(e.category) ? e.category : "happening") as ScrapedEvent["category"],
      sourceUrl: resolvedSourceUrl,
      sourceName,
    };
  }));
}

export async function parseEventsFromHtml(
  html: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string
): Promise<ScrapedEvent[]> {
  const strippedContent = stripHtml(html);
  console.log(
    `HTML: ${html.length} chars → stripped: ${strippedContent.length} chars`
  );
  return sendToClaude(strippedContent, sourceName, sourceUrl, apiKey);
}

export async function parseEventsFromText(
  text: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string
): Promise<ScrapedEvent[]> {
  return sendToClaude(text, sourceName, sourceUrl, apiKey);
}
