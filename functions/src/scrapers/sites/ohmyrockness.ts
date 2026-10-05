import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromText } from "../../services/parser.js";

const BASE_URL = "https://www.ohmyrockness.com/shows";
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

interface OmrShow {
  id: number;
  starts_at?: string;
  url?: string;
  cached_bands?: Array<{ name?: string }>;
  venue?: OmrVenue;
  price?: string;
  age?: string;
  stage?: string;
}

function extractDataShows(html: string): OmrShow[] {
  const allShows: OmrShow[] = [];
  const regex = /data-shows="([^"]*)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const decoded = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'");
      const shows = JSON.parse(decoded) as OmrShow[];
      allShows.push(...shows);
    } catch {
      // skip malformed JSON
    }
  }
  return allShows;
}

export function createOhMyRocknessScraper(apiKey: string): EventSource {
  return {
    name: "ohmyrockness",
    async scrape(): Promise<ScrapedEvent[]> {
      console.log(`Fetching OhMyRockness: ${BASE_URL}`);
      const response = await fetch(BASE_URL, { headers: FETCH_HEADERS });
      if (!response.ok) {
        console.error(`OhMyRockness failed: ${response.status}`);
        return [];
      }

      const html = await response.text();
      console.log(`OhMyRockness HTML: ${html.length} chars`);

      const shows = extractDataShows(html);
      console.log(`Extracted ${shows.length} shows from data-shows JSON`);

      if (shows.length === 0) {
        console.warn("No shows found in data-shows attributes");
        return [];
      }

      // Filter to shows within the next 3 days
      const now = new Date();
      const threeDaysOut = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const upcomingShows = shows.filter((show) => {
        if (!show.starts_at) return false;
        const startDate = new Date(show.starts_at);
        return startDate >= now && startDate <= threeDaysOut;
      });

      console.log(`${upcomingShows.length} shows within next 3 days`);

      // If no shows in the next 3 days, use all shows (they're curated/popular)
      const showsToProcess = upcomingShows.length > 0 ? upcomingShows : shows;

      // Format as text for Claude to categorize
      const eventTexts = showsToProcess.map((show) => {
        const bands = (show.cached_bands ?? [])
          .map((b) => b.name)
          .filter(Boolean)
          .join(", ");
        const venue = show.venue;
        const locationParts: string[] = [];
        if (venue?.name) locationParts.push(venue.name);
        if (venue?.full_address) locationParts.push(venue.full_address.replace(/\n/g, ", "));

        const start = show.starts_at ? new Date(show.starts_at) : null;
        const formatET = (d: Date) =>
          d.toLocaleString("en-US", {
            timeZone: "America/New_York",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false,
          });

        return (
          `Event: ${bands || "Unknown Artist"}\n` +
          `Description: Live concert${show.stage ? ` (${show.stage})` : ""}${show.price ? `, ${show.price}` : ""}${show.age ? `, ${show.age}` : ""}\n` +
          `Start (Eastern Time): ${start ? formatET(start) : "unknown"}\n` +
          `End (Eastern Time): unknown\n` +
          `Location: ${locationParts.join(", ")}\n` +
          `URL: ${show.url || ""}`
        );
      });

      const fullText = eventTexts.join("\n\n---\n\n");
      console.log(`Sending ${eventTexts.length} shows to Claude (${fullText.length} chars)`);

      const parsedEvents = await parseEventsFromText(
        fullText,
        "ohmyrockness",
        BASE_URL,
        apiKey
      );
      console.log(`Claude returned ${parsedEvents.length} categorized events`);

      // Overlay coordinates and URLs from the best structured-data match.
      // Artist names repeat across dates and venues, so score venue and time
      // instead of always taking the first show with the same band.
      for (const parsed of parsedEvents) {
        const parsedLocation = parsed.location.toLowerCase();
        const candidates = showsToProcess
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
        if (match) {
          if (match.venue?.latitude && match.venue?.longitude) {
            parsed.latitude = parseFloat(match.venue.latitude);
            parsed.longitude = parseFloat(match.venue.longitude);
          }
          if (match.url) {
            // Normalize to https
            parsed.sourceUrl = match.url.replace(/^http:/, "https:");
          }
        }
      }

      return parsedEvents;
    },
  };
}
