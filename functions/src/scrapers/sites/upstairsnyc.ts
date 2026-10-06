import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromText, stripHtml } from "../../services/parser.js";

const BASE_URL = "https://www.upstairsnyc.org";
// The curated "upcoming" page (Wix Events widget + latest Loop cards) and
// the Insider's Loop blog listing (one post per recommended event).
const LISTING_URLS = [`${BASE_URL}/upcoming`, `${BASE_URL}/insiders-loop`];
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};
// Bound per-run work: each detail page is a large Wix page (~1MB raw).
const MAX_DETAIL_PAGES = 12;
const MAX_POST_CHARS = 8000;

interface DetailEntry {
  url: string;
  kind: "event" | "post";
  title: string;
  text: string;
}

export function extractDetailUrls(html: string): string[] {
  const urls: string[] = [];
  const regex =
    /href=["']((?:https:\/\/www\.upstairsnyc\.org)?\/(?:events-1|post)\/[^"'?#\s/]+)\/?(?:[?#][^"']*)?["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const path = match[1].replace(/&amp;/g, "&");
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

export interface WixPostalAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string | { name?: string };
}

export interface WixEventJsonLd {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: {
    name?: string;
    address?: string | WixPostalAddress;
  };
}

function findEventJsonLd(value: unknown): WixEventJsonLd | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const event = findEventJsonLd(item);
      if (event) return event;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const rawType = record["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (types.some((type) => typeof type === "string" && type === "Event")) {
    return record as WixEventJsonLd;
  }

  return findEventJsonLd(record["@graph"]);
}

export function extractEventJsonLd(html: string): WixEventJsonLd | null {
  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const event = findEventJsonLd(JSON.parse(match[1]) as unknown);
      if (event) return event;
    } catch {
      // skip malformed JSON-LD
    }
  }
  return null;
}

export function extractPostTitle(html: string): string {
  const headline = html.match(
    /"@type"\s*:\s*"BlogPosting"[\s\S]{0,2000}?"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/
  );
  if (headline) {
    try {
      return JSON.parse(`"${headline[1]}"`);
    } catch {
      return headline[1];
    }
  }
  const ogTitle = html.match(
    /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i
  );
  return ogTitle ? ogTitle[1].replace(/&amp;/g, "&").trim() : "";
}

function formatET(d: Date): string {
  const s = d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return s.replace(/\b24:/, "00:");
}

function formatAddress(address: string | WixPostalAddress | undefined): string {
  if (!address) return "";
  if (typeof address === "string") return address;
  const country =
    typeof address.addressCountry === "string"
      ? address.addressCountry
      : address.addressCountry?.name;
  return [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    country,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

export function eventToText(event: WixEventJsonLd, url: string): string | null {
  if (!event.name || !event.startDate) return null;
  const start = new Date(event.startDate);
  if (isNaN(start.getTime())) return null;
  const end = event.endDate ? new Date(event.endDate) : null;
  const locationParts: string[] = [];
  if (event.location?.name) locationParts.push(event.location.name);
  const address = formatAddress(event.location?.address);
  if (address) locationParts.push(address);
  return (
    `Event: ${event.name}\n` +
    `Description: ${event.description || "N/A"}\n` +
    `Start (Eastern Time): ${formatET(start)}\n` +
    `End (Eastern Time): ${end && !isNaN(end.getTime()) ? formatET(end) : "unknown"}\n` +
    `Location: ${locationParts.join(", ") || "NYC"}\n` +
    `URL: ${url}`
  );
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS });
    if (!response.ok) {
      console.warn(`Upstairs NYC fetch failed (${response.status}): ${url}`);
      return null;
    }
    return await response.text();
  } catch (err) {
    console.warn(`Upstairs NYC fetch error for ${url}:`, err);
    return null;
  }
}

export function createUpstairsNycScraper(apiKey: string): EventSource {
  return {
    name: "upstairsnyc",
    async scrape(): Promise<ScrapedEvent[]> {
      // Step 1: collect detail-page URLs from the listing pages.
      const detailUrls: string[] = [];
      for (const listingUrl of LISTING_URLS) {
        console.log(`Fetching Upstairs NYC listing: ${listingUrl}`);
        const html = await fetchHtml(listingUrl);
        if (!html) continue;
        for (const url of extractDetailUrls(html)) {
          if (!detailUrls.includes(url)) detailUrls.push(url);
        }
        console.log(`Found ${detailUrls.length} unique detail URLs so far`);
      }

      if (detailUrls.length === 0) {
        console.error("No Upstairs NYC detail URLs found across listing pages");
        return [];
      }

      // Wix Events pages carry exact structured data — scrape those first.
      detailUrls.sort((a, b) => {
        const score = (url: string) => (url.includes("/events-1/") ? 0 : 1);
        return score(a) - score(b);
      });
      const pagesToFetch = detailUrls.slice(0, MAX_DETAIL_PAGES);
      console.log(
        `Fetching ${pagesToFetch.length}/${detailUrls.length} Upstairs NYC detail pages`
      );

      // Step 2: turn each detail page into a text block for Claude.
      // events-1 pages use their JSON-LD Event data (exact dates/venue);
      // blog posts use their stripped body text (Practical Info section).
      const now = Date.now();
      const entries: DetailEntry[] = [];
      for (const url of pagesToFetch) {
        const html = await fetchHtml(url);
        if (!html) continue;
        if (url.includes("/events-1/")) {
          const event = extractEventJsonLd(html);
          if (!event) {
            console.warn(`No JSON-LD event data found on: ${url}`);
            continue;
          }
          if (event.endDate && new Date(event.endDate).getTime() < now) {
            console.log(`Skipped past event: "${event.name}"`);
            continue;
          }
          const text = eventToText(event, url);
          if (!text || !event.name) continue;
          entries.push({ url, kind: "event", title: event.name, text });
        } else {
          const stripped = stripHtml(html);
          entries.push({
            url,
            kind: "post",
            title: extractPostTitle(html),
            text: `Post URL: ${url}\n\n${stripped.slice(0, MAX_POST_CHARS)}`,
          });
        }
      }

      console.log(
        `Collected ${entries.length} text blocks ` +
          `(${entries.filter((e) => e.kind === "event").length} events, ` +
          `${entries.filter((e) => e.kind === "post").length} posts)`
      );
      if (entries.length === 0) {
        return [];
      }

      // Step 3: one Claude pass to extract + categorize, same as other sources.
      const fullText = entries.map((e) => e.text).join("\n\n---\n\n");
      console.log(
        `Sending ${entries.length} Upstairs NYC blocks to Claude (${fullText.length} chars)`
      );
      const parsedEvents = await parseEventsFromText(
        fullText,
        "upstairsnyc",
        BASE_URL,
        apiKey
      );
      console.log(`Upstairs NYC: Claude extracted ${parsedEvents.length} events`);

      // Step 4: pin each parsed event to its exact detail-page URL so every
      // event is sourced to the specific page it came from. A specific URL
      // Claude found (e.g. a ticket page) is kept; only the generic listing
      // fallback is replaced with the detail page the event was extracted from.
      for (const parsed of parsedEvents) {
        const parsedPrefix = parsed.title.toLowerCase().slice(0, 20);
        const match = entries.find((entry) => {
          if (!entry.title) return false;
          const entryPrefix = entry.title.toLowerCase().slice(0, 20);
          return (
            parsed.title.toLowerCase().includes(entryPrefix) ||
            entry.title.toLowerCase().includes(parsedPrefix)
          );
        });
        if (match && (!parsed.sourceUrl || parsed.sourceUrl === BASE_URL)) {
          parsed.sourceUrl = match.url;
        }
      }

      // Same upcoming-only scope as the other sources: don't write events
      // from older Loop posts that have already ended.
      const upcomingEvents = parsedEvents.filter(
        (event) => event.endTimestamp >= now
      );
      console.log(
        `Upstairs NYC: ${upcomingEvents.length}/${parsedEvents.length} events have not ended yet`
      );

      return upcomingEvents;
    },
  };
}
