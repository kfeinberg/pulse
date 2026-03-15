import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromText, stripHtml } from "../../services/parser.js";

const BASE_URL = "https://www.nycforfree.co/events";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface SquarespaceEvent {
  title?: string;
  body?: string;
  startDate?: number;
  endDate?: number;
  location?: {
    addressLine1?: string;
    addressLine2?: string;
    addressTitle?: string;
    mapLat?: number;
    mapLng?: number;
  };
  excerpt?: string;
  fullUrl?: string;
}

interface SquarespaceResponse {
  upcoming?: SquarespaceEvent[];
  pagination?: {
    nextPage?: boolean;
    nextPageOffset?: number;
  };
}

async function fetchAllUpcoming(): Promise<SquarespaceEvent[]> {
  const allEvents: SquarespaceEvent[] = [];
  let offset: number | undefined;

  while (true) {
    const url = offset
      ? `${BASE_URL}?format=json&offset=${offset}`
      : `${BASE_URL}?format=json`;

    console.log(`Fetching: ${url}`);
    const response = await fetch(url, { headers: FETCH_HEADERS });
    console.log(`Response status: ${response.status}, content-type: ${response.headers.get("content-type")}`);
    if (!response.ok) {
      const body = await response.text();
      console.error(`Failed to fetch ${url}: ${response.status}, body: ${body.slice(0, 500)}`);
      break;
    }

    const rawText = await response.text();
    console.log(`Raw response length: ${rawText.length}, preview: ${rawText.slice(0, 300)}`);

    let data: SquarespaceResponse;
    try {
      data = JSON.parse(rawText) as SquarespaceResponse;
    } catch (err) {
      console.error(`Failed to parse JSON response: ${err}`);
      break;
    }

    console.log(`Parsed keys: ${Object.keys(data).join(", ")}`);
    const upcoming = data.upcoming ?? [];
    console.log(`upcoming array length: ${upcoming.length}, first item keys: ${upcoming[0] ? Object.keys(upcoming[0]).join(", ") : "N/A"}`);
    allEvents.push(...upcoming);
    console.log(
      `Fetched page (offset=${offset ?? "none"}): ${upcoming.length} events, total so far: ${allEvents.length}`
    );

    if (data.pagination?.nextPage && data.pagination.nextPageOffset) {
      offset = data.pagination.nextPageOffset;
    } else {
      break;
    }
  }

  return allEvents;
}

export function createNycForFreeScraper(apiKey: string): EventSource {
  return {
    name: "nycforfree",
    async scrape(): Promise<ScrapedEvent[]> {
      const allItems = await fetchAllUpcoming();
      console.log(`Total upcoming events from all pages: ${allItems.length}`);

      // Format API data as text for Claude to process
      const eventTexts: string[] = [];
      for (const item of allItems) {
        if (!item.title || !item.startDate) continue;

        const locationParts: string[] = [];
        if (item.location?.addressTitle)
          locationParts.push(item.location.addressTitle);
        if (item.location?.addressLine1)
          locationParts.push(item.location.addressLine1);
        if (item.location?.addressLine2)
          locationParts.push(item.location.addressLine2);

        let description = "";
        if (item.excerpt) {
          description = stripHtml(item.excerpt);
        } else if (item.body) {
          description = stripHtml(item.body);
        }

        const startDate = new Date(item.startDate);
        const endDate = item.endDate ? new Date(item.endDate) : null;

        eventTexts.push(
          `Event: ${item.title}\n` +
          `Description: ${description}\n` +
          `Start: ${startDate.toISOString()}\n` +
          `End: ${endDate ? endDate.toISOString() : "unknown"}\n` +
          `Location: ${locationParts.join(", ")}`
        );
      }

      const fullText = eventTexts.join("\n\n---\n\n");
      console.log(`Formatted ${eventTexts.length} events as text (${fullText.length} chars)`);
      console.log(`First 500 chars of text sent to Claude:\n${fullText.slice(0, 500)}`);

      if (eventTexts.length === 0) {
        console.warn("No events to send to Claude — all items were filtered out (missing title or startDate)");
        return [];
      }

      const results = await parseEventsFromText(fullText, "nycforfree", BASE_URL, apiKey);
      console.log(`Claude returned ${results.length} events`);
      return results;
    },
  };
}
