import { EventSource, ScrapedEvent } from "../base.js";
import type { ExtractionCache } from "../../services/extractionCache.js";
import { parseNewItems } from "../../services/parser.js";

// https://www.ohmyrockness.com/shows renders its "Shows / By / Date" list
// client-side from /api/shows.json (50 shows per page, date-ordered). The
// only data-shows attributes in the server HTML are the "Just Announced" and
// "Most Popular" sidebars, so the list itself has to come from the API.
// The site's bundled JS sends a public token with every API request; we read
// it from that bundle at scrape time (so rotation does not break this source)
// and fall back to the last known value.
const BASE_URL = "https://www.ohmyrockness.com/shows";
const ORIGIN = "https://www.ohmyrockness.com";
const FALLBACK_API_TOKEN = "3b35f8a73dabd5f14b1cac167a14c1f6";
const PER_PAGE = 50;
// ~50 NYC shows per day, so 3 days fits in 3-4 pages; the cap bounds a run.
const MAX_PAGES = 8;
const WINDOW_DAYS = 3;
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface OmrVenue {
  name?: string;
  full_address?: string;
  latitude?: string;
  longitude?: string;
}

export interface OmrShow {
  id: number;
  starts_at?: string;
  url?: string;
  cached_bands?: Array<{ name?: string }>;
  venue?: OmrVenue;
  price?: string;
  age?: string;
  stage?: string;
}

export function extractBundleUrl(html: string): string | null {
  const match = html.match(/<script[^>]*src="(\/assets\/application-[a-f0-9]+\.js)"/);
  return match ? `${ORIGIN}${match[1]}` : null;
}

export function extractApiToken(js: string): string | null {
  // The lazy loader is `t="<token>",$.fn.lazy=function(){ ... 'Token token="'+t+'"' ...`.
  const match = js.match(/(\w+)="([a-f0-9]{32})",\$\.fn\.lazy=function/);
  return match ? match[2] : null;
}

async function discoverApiToken(): Promise<string> {
  try {
    const pageResponse = await fetch(BASE_URL, { headers: FETCH_HEADERS });
    const bundleUrl = pageResponse.ok ? extractBundleUrl(await pageResponse.text()) : null;
    if (bundleUrl) {
      const bundleResponse = await fetch(bundleUrl, { headers: FETCH_HEADERS });
      const token = bundleResponse.ok ? extractApiToken(await bundleResponse.text()) : null;
      if (token) return token;
    }
    console.warn("OhMyRockness API token not found in site bundle; using fallback");
  } catch (err) {
    console.warn("OhMyRockness API token discovery failed; using fallback:", err);
  }
  return FALLBACK_API_TOKEN;
}

export function showsInWindow(shows: OmrShow[], nowMs: number, days: number): OmrShow[] {
  const endMs = nowMs + days * 24 * 60 * 60 * 1000;
  return shows.filter((show) => {
    const startMs = show.starts_at ? Date.parse(show.starts_at) : NaN;
    return Number.isFinite(startMs) && startMs >= nowMs && startMs <= endMs;
  });
}

async function fetchUpcomingShows(nowMs: number): Promise<OmrShow[]> {
  const token = await discoverApiToken();
  const windowEndMs = nowMs + WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const shows: OmrShow[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${ORIGIN}/api/shows.json?index=true&page=${page}&per=${PER_PAGE}&regioned=1`;
    const response = await fetch(url, {
      headers: {
        ...FETCH_HEADERS,
        Accept: "application/json",
        Referer: BASE_URL,
        Authorization: `Token token="${token}"`,
      },
    });
    if (!response.ok) {
      console.error(`OhMyRockness API page ${page} failed: ${response.status}`);
      break;
    }
    const pageShows = (await response.json()) as OmrShow[];
    if (!Array.isArray(pageShows) || pageShows.length === 0) break;
    shows.push(...pageShows);

    // Pages are date-ordered: stop once a page reaches past the window.
    const lastStartMs = Date.parse(pageShows[pageShows.length - 1].starts_at ?? "");
    if (Number.isFinite(lastStartMs) && lastStartMs > windowEndMs) break;
  }

  console.log(`OhMyRockness API returned ${shows.length} shows`);
  return showsInWindow(shows, nowMs, WINDOW_DAYS);
}

function formatET(d: Date): string {
  return d
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    })
    .replace(/\b24:/, "00:");
}

function showToText(show: OmrShow): string {
  const bands = (show.cached_bands ?? [])
    .map((b) => b.name)
    .filter(Boolean)
    .join(", ");
  const venue = show.venue;
  const locationParts: string[] = [];
  if (venue?.name) locationParts.push(venue.name);
  if (venue?.full_address) locationParts.push(venue.full_address.replace(/\n/g, ", "));
  const start = show.starts_at ? new Date(show.starts_at) : null;

  return (
    `Event: ${bands || "Unknown Artist"}\n` +
    `Description: Live concert${show.stage ? ` (${show.stage})` : ""}${show.price ? `, ${show.price}` : ""}${show.age ? `, ${show.age}` : ""}\n` +
    `Start (Eastern Time): ${start ? formatET(start) : "unknown"}\n` +
    `End (Eastern Time): unknown\n` +
    `Location: ${locationParts.join(", ")}\n` +
    `URL: ${show.url || ""}`
  );
}

// Overlay coordinates and URLs from the best structured-data match.
// Artist names repeat across dates and venues, so score venue and time
// instead of always taking the first show with the same band.
function overlayShowData(parsed: ScrapedEvent, shows: OmrShow[]): void {
  const parsedLocation = parsed.location.toLowerCase();
  const candidates = shows
    .filter((show) => {
      const bands = (show.cached_bands ?? []).map((band) => band.name?.toLowerCase() ?? "");
      return bands.some(
        (band) => band && parsed.title.toLowerCase().includes(band.slice(0, 15))
      );
    })
    .map((show) => {
      let score = 1;
      const venueName = show.venue?.name?.toLowerCase();
      const venueAddress = show.venue?.full_address?.toLowerCase().replace(/\n/g, ", ");
      if (venueName && parsedLocation.includes(venueName)) score += 5;
      if (venueAddress && parsedLocation.includes(venueAddress.split(",")[0])) score += 3;
      if (show.starts_at) {
        const timeDifference = Math.abs(
          new Date(show.starts_at).getTime() - parsed.startTimestamp
        );
        if (timeDifference <= 15 * 60 * 1000) score += 5;
        else if (timeDifference <= 24 * 60 * 60 * 1000) score += 2;
      }
      return { show, score };
    })
    .sort((a, b) => b.score - a.score);
  const match = candidates[0]?.show;
  if (!match) return;
  if (match.venue?.latitude && match.venue?.longitude) {
    parsed.latitude = parseFloat(match.venue.latitude);
    parsed.longitude = parseFloat(match.venue.longitude);
  }
  if (match.url) {
    parsed.sourceUrl = match.url.replace(/^http:/, "https:");
  }
}

export function createOhMyRocknessScraper(apiKey: string): EventSource {
  return {
    name: "ohmyrockness",
    async scrape(cache: ExtractionCache): Promise<ScrapedEvent[]> {
      const shows = await fetchUpcomingShows(Date.now());
      console.log(`${shows.length} OhMyRockness shows within next ${WINDOW_DAYS} days`);
      if (shows.length === 0) return [];

      // One Claude pass per ET calendar day (like NYC.gov) keeps each
      // response well under the output limit at ~50 shows per day.
      const byDay = new Map<string, OmrShow[]>();
      for (const show of shows) {
        const day = formatET(new Date(show.starts_at!)).slice(0, 10);
        const group = byDay.get(day) ?? [];
        group.push(show);
        byDay.set(day, group);
      }

      const results: ScrapedEvent[] = [];
      for (const [day, dayShows] of byDay) {
        const { items: sentShows, events: parsedEvents } = await parseNewItems(
          dayShows,
          showToText,
          cache,
          BASE_URL,
          apiKey
        );
        console.log(`OhMyRockness ${day}: Claude returned ${parsedEvents.length} events`);
        for (const parsed of parsedEvents) {
          overlayShowData(parsed, sentShows);
          results.push(parsed);
        }
      }

      return results;
    },
  };
}
