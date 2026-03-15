import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromText } from "../../services/parser.js";

const BROWSE_BASE =
  "https://dice.fm/browse/new_york-5bbf4db0f06331478e9b2c59";

function getTodayEST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function getBrowseUrl(): string {
  const today = getTodayEST();
  return `${BROWSE_BASE}?from=${today}&until=${today}`;
}
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface DiceJsonLdEvent {
  "@type"?: string;
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: {
    name?: string;
    address?: string;
    geo?: {
      latitude?: number;
      longitude?: number;
    };
  };
}

function extractEventUrls(html: string): string[] {
  const urls: string[] = [];
  // Match both absolute and relative event URLs
  const regex = /href=["']((?:https:\/\/dice\.fm)?\/event\/[^"']+)["']/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    let url = match[1];
    // Normalize relative URLs to absolute
    if (url.startsWith("/event/")) {
      url = `https://dice.fm${url}`;
    }
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function extractJsonLd(html: string): DiceJsonLdEvent | null {
  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const eventType = data["@type"] || "";
      if (eventType.includes("Event") || eventType.includes("MusicEvent")) {
        return data as DiceJsonLdEvent;
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  return null;
}

async function fetchEventDetails(
  url: string
): Promise<{ event: DiceJsonLdEvent; url: string } | null> {
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS });
    if (!response.ok) {
      console.warn(`Dice event page ${response.status}: ${url}`);
      return null;
    }
    const html = await response.text();
    const event = extractJsonLd(html);
    if (!event) {
      console.warn(`No JSON-LD event data found on: ${url}`);
      return null;
    }
    return { event, url };
  } catch (err) {
    console.warn(`Failed to fetch event page ${url}:`, err);
    return null;
  }
}

export function createDiceScraper(apiKey: string): EventSource {
  return {
    name: "dice",
    async scrape(): Promise<ScrapedEvent[]> {
      // Step 1: Fetch browse page and extract event URLs
      const browseUrl = getBrowseUrl();
      console.log(`Fetching Dice browse page: ${browseUrl}`);
      const browseRes = await fetch(browseUrl, { headers: FETCH_HEADERS });
      if (!browseRes.ok) {
        console.error(
          `Failed to fetch Dice browse page: ${browseRes.status}`
        );
        return [];
      }
      const browseHtml = await browseRes.text();
      console.log(`Dice browse page: ${browseHtml.length} chars`);

      const eventUrls = extractEventUrls(browseHtml);
      console.log(`Found ${eventUrls.length} event URLs`);
      if (eventUrls.length === 0) {
        console.error(`No event URLs found in ${browseHtml.length} chars of HTML`);
        return [];
      }
      console.log(`First 3 URLs: ${eventUrls.slice(0, 3).join(", ")}`);

      // Step 2: Fetch each event page for JSON-LD details
      const BATCH_SIZE = 5;
      const allDetails: { event: DiceJsonLdEvent; url: string }[] = [];

      for (let i = 0; i < eventUrls.length; i += BATCH_SIZE) {
        const batch = eventUrls.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(fetchEventDetails));
        for (const r of results) {
          if (r) allDetails.push(r);
        }
        console.log(
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${allDetails.length} events with JSON-LD so far`
        );
      }

      console.log(
        `Got JSON-LD details for ${allDetails.length}/${eventUrls.length} events`
      );

      // Step 3: Format for Claude to categorize
      const eventTexts = allDetails.filter(({ event }) => !!event.name && !!event.startDate).map(({ event, url }) => {
        const locationParts: string[] = [];
        if (event.location?.name) locationParts.push(event.location.name);
        if (event.location?.address) locationParts.push(event.location.address);

        const start = new Date(event.startDate!);
        const end = event.endDate ? new Date(event.endDate) : null;

        return (
          `Event: ${event.name}\n` +
          `Description: ${event.description || "N/A"}\n` +
          `Type: ${event["@type"] || "Event"}\n` +
          `Start: ${start.toISOString()}\n` +
          `End: ${end ? end.toISOString() : "unknown"}\n` +
          `Location: ${locationParts.join(", ")}\n` +
          `URL: ${url}`
        );
      });

      const fullText = eventTexts.join("\n\n---\n\n");
      console.log(
        `Sending ${eventTexts.length} events to Claude (${fullText.length} chars)`
      );

      const parsedEvents = await parseEventsFromText(
        fullText,
        "dice",
        browseUrl,
        apiKey
      );
      console.log(`Claude returned ${parsedEvents.length} categorized events`);

      // Step 4: Overlay geo coordinates from JSON-LD
      for (const parsed of parsedEvents) {
        const match = allDetails.find(
          ({ event }) =>
            event.name &&
            parsed.title
              .toLowerCase()
              .includes(event.name.toLowerCase().slice(0, 20))
        );
        if (match?.event.location?.geo) {
          parsed.latitude = match.event.location.geo.latitude;
          parsed.longitude = match.event.location.geo.longitude;
        }
      }

      return parsedEvents;
    },
  };
}
