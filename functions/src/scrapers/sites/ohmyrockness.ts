import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromHtml } from "../../services/parser.js";

const BASE_URL = "https://www.ohmyrockness.com/shows";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export function createOhMyRocknessScraper(apiKey: string): EventSource {
  return {
    name: "ohmyrockness",
    async scrape(): Promise<ScrapedEvent[]> {
      const allEvents: ScrapedEvent[] = [];

      // Scrape first 3 pages of shows
      for (let page = 1; page <= 3; page++) {
        const url = `${BASE_URL}?page=${page}`;
        console.log(`Fetching OhMyRockness page ${page}: ${url}`);

        try {
          const response = await fetch(url, { headers: FETCH_HEADERS });
          if (!response.ok) {
            console.error(`OhMyRockness page ${page} failed: ${response.status}`);
            continue;
          }

          const html = await response.text();
          console.log(`OhMyRockness page ${page}: ${html.length} chars`);

          if (html.length < 1000) {
            console.warn(`OhMyRockness page ${page} too short, skipping`);
            continue;
          }

          const events = await parseEventsFromHtml(html, "ohmyrockness", url, apiKey);
          console.log(`OhMyRockness page ${page}: Claude extracted ${events.length} events`);
          allEvents.push(...events);
        } catch (err) {
          console.error(`OhMyRockness page ${page} error:`, err);
        }
      }

      console.log(`OhMyRockness total: ${allEvents.length} events`);
      return allEvents;
    },
  };
}
