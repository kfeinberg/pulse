import type { EventSource, ScrapedEvent, SourceLocation } from "../base.js";
import type { ExtractionCache } from "../../services/extractionCache.js";
import { isDiceEventUrl, isNycCentroid, isOutsideNyc, isSpecificSourceAddress, isWithinNyc } from "../../services/geocoder.js";
import { parseNewItems } from "../../services/parser.js";

const BROWSE_BASE =
  "https://dice.fm/browse/new_york-5bbf4db0f06331478e9b2c59";

function getDateEST(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function getBrowseUrls(): string[] {
  return [0, 1, 2].map((offset) => {
    const date = getDateEST(offset);
    return `${BROWSE_BASE}?from=${date}&until=${date}`;
  });
}
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface DicePostalAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
}

export interface DiceJsonLdEvent {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: {
    name?: string;
    address?: string | DicePostalAddress;
    geo?: {
      latitude?: number | string;
      longitude?: number | string;
    };
  };
}

export interface DiceDetail {
  event: DiceJsonLdEvent;
  url: string;
}

const clean = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const withoutCountry = (value: string) => value.replace(/,\s*(?:United States|USA)$/i, "");

// Dice publishes a schema.org PostalAddress object. Interpolating it into the
// extraction text used to produce "[object Object]", leaving the model only
// the venue name, which the geocoder usually could not place. Its
// streetAddress normally already carries the borough, state and ZIP (and the
// separate addressLocality is sometimes wrong), so it wins when complete.
export function formatDiceAddress(address: unknown): string {
  if (typeof address === "string") return withoutCountry(clean(address));
  if (!address || typeof address !== "object") return "";
  const postal = address as DicePostalAddress;
  const street = withoutCountry(clean(postal.streetAddress));
  if (street && /\b\d{5}\b|,\s*(?:NY|New York)\b/i.test(street)) return street;
  const parts: string[] = [];
  for (const part of [street, clean(postal.addressLocality), clean(postal.addressRegion), clean(postal.postalCode)]) {
    if (part && !parts.some((previous) => previous.toLowerCase().includes(part.toLowerCase()))) parts.push(part);
  }
  return parts.join(", ");
}

export function diceVenueLabel(event: DiceJsonLdEvent): string {
  const name = clean(event.location?.name);
  const address = formatDiceAddress(event.location?.address);
  if (!address) return name;
  return name && !address.toLowerCase().includes(name.toLowerCase()) ? `${name}, ${address}` : address;
}

// The venue's own coordinates from the event page, trusted only inside NYC
// and only for a specific street address on that same event URL.
export function diceSourcePin(detail: DiceDetail): SourceLocation | undefined {
  const address = formatDiceAddress(detail.event.location?.address);
  const latitude = Number(detail.event.location?.geo?.latitude);
  const longitude = Number(detail.event.location?.geo?.longitude);
  if (!isDiceEventUrl(detail.url) || !isSpecificSourceAddress(address) || isOutsideNyc(address) ||
      !isWithinNyc(latitude, longitude) || isNycCentroid(latitude, longitude)) return undefined;
  const placeName = clean(detail.event.location?.name);
  return { latitude, longitude, address, ...(placeName ? { placeName } : {}), sourceUrl: detail.url };
}

// Prefer the exact event URL the model copied from the item; fall back to a
// title prefix only when it identifies exactly one item.
export function matchDiceDetail(parsed: ScrapedEvent, details: DiceDetail[]): DiceDetail | undefined {
  const byUrl = details.find((detail) => detail.url === parsed.sourceUrl);
  if (byUrl) return byUrl;
  const title = parsed.title.toLowerCase();
  const byTitle = details.filter(({ event }) => event.name && title.includes(event.name.toLowerCase().slice(0, 20)));
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

export function overlayDiceDetail(parsed: ScrapedEvent, detail: DiceDetail): void {
  parsed.sourceUrl = detail.url;
  const pin = diceSourcePin(detail);
  if (!pin) return;
  parsed.location = diceVenueLabel(detail.event);
  parsed.sourceLocation = pin;
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

function isEventNode(value: unknown): value is DiceJsonLdEvent {
  if (!value || typeof value !== "object") return false;
  const types = ([] as unknown[]).concat((value as DiceJsonLdEvent)["@type"] ?? []);
  return types.some((type) => typeof type === "string" && /Event$/.test(type));
}

export function extractJsonLd(html: string): DiceJsonLdEvent | null {
  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      // MusicEvent, ScreeningEvent, ComedyEvent...: a node, an array or a @graph.
      const candidates: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.["@graph"]) ? data["@graph"] : [data];
      const event = candidates.find(isEventNode);
      if (event) return event;
    } catch {
      // skip malformed JSON-LD
    }
  }
  return null;
}

async function fetchEventDetails(
  url: string
): Promise<DiceDetail | null> {
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(20_000) });
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
    async scrape(cache: ExtractionCache): Promise<ScrapedEvent[]> {
      // Step 1: Fetch browse pages for today + next 2 days and extract event URLs
      const browseUrls = getBrowseUrls();
      const eventUrls: string[] = [];

      for (const browseUrl of browseUrls) {
        console.log(`Fetching Dice browse page: ${browseUrl}`);
        const browseRes = await fetch(browseUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(30_000) });
        if (!browseRes.ok) {
          console.error(`Failed to fetch Dice browse page: ${browseRes.status}`);
          continue;
        }
        const browseHtml = await browseRes.text();
        console.log(`Dice browse page: ${browseHtml.length} chars`);

        const urls = extractEventUrls(browseHtml);
        for (const url of urls) {
          if (!eventUrls.includes(url)) eventUrls.push(url);
        }
        console.log(`Found ${urls.length} event URLs (${eventUrls.length} unique total)`);
      }

      if (eventUrls.length === 0) {
        console.error("No event URLs found across all browse pages");
        return [];
      }
      console.log(`First 3 URLs: ${eventUrls.slice(0, 3).join(", ")}`);

      // Step 2: Fetch each event page for JSON-LD details
      const BATCH_SIZE = 5;
      const allDetails: DiceDetail[] = [];

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
      const eventToText = ({ event, url }: DiceDetail) => {

        const start = new Date(event.startDate!);
        const end = event.endDate ? new Date(event.endDate) : null;

        const formatET = (d: Date) => {
          const s = d.toLocaleString("en-US", {
            timeZone: "America/New_York",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false,
          });
          // Some environments produce "24:00" for midnight — normalize to "00:00"
          return s.replace(/\b24:/, "00:");
        };

        return (
          `Event: ${event.name}\n` +
          `Description: ${event.description || "N/A"}\n` +
          `Type: ${event["@type"] || "Event"}\n` +
          `Start (Eastern Time): ${formatET(start)}\n` +
          `End (Eastern Time): ${end ? formatET(end) : "unknown"}\n` +
          `Location: ${diceVenueLabel(event)}\n` +
          `URL: ${url}`
        );
      };

      const { items: sentDetails, events: parsedEvents } = await parseNewItems(
        allDetails.filter(({ event }) => !!event.name && !!event.startDate),
        eventToText,
        cache,
        BROWSE_BASE,
        apiKey
      );
      console.log(`Claude returned ${parsedEvents.length} categorized events`);

      // Step 4: Overlay the event URL, venue address and the venue's own
      // coordinates from that event's JSON-LD.
      for (const parsed of parsedEvents) {
        const match = matchDiceDetail(parsed, sentDetails);
        if (match) overlayDiceDetail(parsed, match);
      }

      return parsedEvents;
    },
  };
}
