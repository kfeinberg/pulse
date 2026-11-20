import { EventSource, ScrapedEvent } from "../base.js";
import { itemKey, type ExtractionCache } from "../../services/extractionCache.js";
import { parseNewItems } from "../../services/parser.js";

type ExtractItems = NonNullable<NonNullable<Parameters<typeof parseNewItems>[5]>["extract"]>;
import { resolveEventbriteUrl } from "../../services/eventUrl.js";

const BASE_URL = "https://ny-event-radar.com/";
const SUPABASE_URL = "https://ropievbxucezuacvgpbk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvcGlldmJ4dWNlenVhY3ZncGJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ4ODc1NzUsImV4cCI6MjA3MDQ2MzU3NX0.0PvTw-Hg3bcOWeDfD0T_Nuj6wCVLCRIkRcfPwnFJucI";

interface NerEvent {
  id: string;
  title: string;
  description?: string;
  date?: string;
  location?: string;
  address?: string;
  price?: string;
  category?: string;
  url?: string;
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  published?: boolean;
}

// The calendar window is in New York time: after 7pm ET the UTC date is
// already tomorrow, which would drop the rest of tonight's events.
export function getDateString(daysFromNow: number, nowMs = Date.now()): string {
  return new Date(nowMs + daysFromNow * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function createNYEventRadarScraper(
  apiKey: string,
  dependencies: { fetch?: typeof fetch; extract?: ExtractItems; now?: () => number } = {}
): EventSource {
  const request = dependencies.fetch ?? fetch;
  return {
    name: "nyeventradar",
    async scrape(cache: ExtractionCache): Promise<ScrapedEvent[]> {
      const nowMs = (dependencies.now ?? Date.now)();
      const today = getDateString(0, nowMs);
      const threeDaysOut = getDateString(3, nowMs);

      // Query Supabase REST API for events starting in the next 3 days
      const queryParams = new URLSearchParams({
        select: "id,title,description,date,location,address,price,category,url,start_date,end_date,start_time,end_time",
        published: "eq.true",
        or: `(and(start_date.gte.${today},start_date.lte.${threeDaysOut}),and(start_date.is.null,date.gte.${today},date.lte.${threeDaysOut}))`,
        order: "start_date.asc.nullsfirst",
        limit: "100",
      });

      const apiUrl = `${SUPABASE_URL}/rest/v1/events?${queryParams.toString()}`;
      console.log(`Fetching NY Event Radar via Supabase API`);

      const response = await request(apiUrl, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`NY Event Radar API failed (${response.status}): ${body.slice(0, 200)}`);
        return [];
      }

      const events = (await response.json()) as NerEvent[];
      console.log(`NY Event Radar API returned ${events.length} events`);

      if (events.length === 0) {
        return [];
      }

      // NY Event Radar occasionally stores Eventbrite category pages or event
      // slugs without the required numeric ticket ID. Resolve those to a
      // canonical event-detail URL before they reach the extraction pipeline.
      // Eventbrite's search refuses datacenter requests at times (HTTP 405):
      // that costs this one event its deep link, never the whole source. The
      // event is published without the unusable link and extracted again on
      // the next run, when the lookup may succeed.
      const unresolvedLinks = new Set<NerEvent>();
      for (const event of events) {
        if (!event.url) continue;
        try {
          event.url = (await resolveEventbriteUrl(event.title, event.url, { fetch: request })) || undefined;
        } catch (error) {
          cache.recordFailure(String(error));
          event.url = undefined;
          unresolvedLinks.add(event);
        }
      }

      // Format for Claude to categorize
      const eventToText = (event: NerEvent) => {
        const locationParts: string[] = [];
        if (event.location) locationParts.push(event.location);
        if (event.address) locationParts.push(event.address);

        const startDate = event.start_date || event.date || "";
        const endDate = event.end_date || "";

        // Build time strings
        let startStr = startDate;
        if (event.start_time) startStr += ` ${event.start_time}`;
        let endStr = endDate;
        if (event.end_time) endStr += ` ${event.end_time}`;

        return (
          `Event: ${event.title}\n` +
          `Description: ${event.description || "N/A"}\n` +
          `Start: ${startStr || "unknown"}\n` +
          `End: ${endStr || "unknown"}\n` +
          `Location: ${locationParts.join(", ") || "NYC"}\n` +
          `Price: ${event.price || "N/A"}\n` +
          `URL: ${event.url || ""}`
        );
      };

      const { items: sentEvents, events: parsedEvents } = await parseNewItems(
        events,
        eventToText,
        cache,
        BASE_URL,
        apiKey,
        { extract: dependencies.extract }
      );
      console.log(`NY Event Radar: Claude extracted ${parsedEvents.length} events`);
      cache.unstage(sentEvents.filter((event) => unresolvedLinks.has(event)).map((event) => itemKey(cache.sourceName, eventToText(event))));

      // Map individual event URLs back. The URL the model copied from the
      // item is exact; a title prefix is only the fallback.
      for (const parsed of parsedEvents) {
        const match = sentEvents.find((e) => e.url && e.url === parsed.sourceUrl) ?? sentEvents.find(
          (e) =>
            e.title &&
            parsed.title
              .toLowerCase()
              .includes(e.title.toLowerCase().slice(0, 20))
        );
        if (match?.url) {
          parsed.sourceUrl = match.url;
        }
      }

      return parsedEvents;
    },
  };
}
