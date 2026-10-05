import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromText } from "../../services/parser.js";

const BASE_URL = "https://www.nycforfree.co/events";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface WebflowEvent {
  title: string;
  slug: string;
  description: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  address: string;
  borough: string;
  frequency: string;
  sourceCategory: string;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawAttributes)) !== null) {
    attributes[match[1]] = decodeHtmlEntities(match[2]);
  }
  return attributes;
}

function parseWebflowEvents(html: string): WebflowEvent[] {
  const events = new Map<string, WebflowEvent>();
  const itemPattern = /<div\b([^>]*\bclass="[^"]*\bw-dyn-item\b[^"]*"[^>]*)>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemPattern.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.title || !attributes.slug || !attributes["start-date"]) continue;

    events.set(attributes.slug, {
      title: attributes.title,
      slug: attributes.slug,
      description: attributes.description || "",
      startDate: attributes["start-date"],
      endDate: attributes["end-date"] || attributes["start-date"],
      startTime: attributes["start-time"] || "12:00 PM",
      endTime: attributes["end-time"] || "11:59 PM",
      address: attributes.address || "",
      borough: attributes.borough || "",
      frequency: attributes.frequency || "One-time",
      sourceCategory: attributes.category || "",
    });
  }

  return [...events.values()];
}

export function createNycForFreeScraper(apiKey: string): EventSource {
  return {
    name: "nycforfree",
    async scrape(): Promise<ScrapedEvent[]> {
      console.log(`Fetching NYC for FREE: ${BASE_URL}`);
      const response = await fetch(BASE_URL, { headers: FETCH_HEADERS });
      if (!response.ok) {
        const body = await response.text();
        console.error(`NYC for FREE fetch failed (${response.status}): ${body.slice(0, 500)}`);
        return [];
      }

      const html = await response.text();
      const events = parseWebflowEvents(html);
      console.log(`NYC for FREE Webflow page returned ${events.length} events`);
      if (events.length === 0) {
        console.warn(`No event cards found in ${html.length} bytes of HTML`);
        return [];
      }

      const eventTexts = events.map((event) => {
        const location = [event.address, event.borough].filter(Boolean).join(", ");
        const eventUrl = `https://www.nycforfree.co/events/${event.slug}`;
        return (
          `Event: ${event.title}\n` +
          `Description: ${event.description}\n` +
          `Source category: ${event.sourceCategory || "N/A"}\n` +
          `Frequency: ${event.frequency}\n` +
          `Start (Eastern Time): ${event.startDate} ${event.startTime}\n` +
          `End (Eastern Time): ${event.endDate} ${event.endTime}\n` +
          `Location: ${location || "NYC"}\n` +
          `URL: ${eventUrl}`
        );
      });

      const fullText = eventTexts.join("\n\n---\n\n");
      console.log(`Sending ${events.length} NYC for FREE events to Claude (${fullText.length} chars)`);
      const results = await parseEventsFromText(fullText, "nycforfree", BASE_URL, apiKey);
      console.log(`NYC for FREE: Claude extracted ${results.length} events`);

      for (const parsed of results) {
        const match = events.find(
          (event) =>
            parsed.title.toLowerCase().includes(event.title.toLowerCase().slice(0, 20)) ||
            event.title.toLowerCase().includes(parsed.title.toLowerCase().slice(0, 20))
        );
        if (match) {
          parsed.sourceUrl = `https://www.nycforfree.co/events/${match.slug}`;
        }
      }

      return results;
    },
  };
}
