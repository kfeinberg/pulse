import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromHtml } from "../../services/parser.js";

const BASE_URL = "https://www.theskint.com/";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export function createTheSkintScraper(apiKey: string): EventSource {
  return {
    name: "theskint",
    async scrape(): Promise<ScrapedEvent[]> {
      console.log(`Fetching The Skint: ${BASE_URL}`);
      const response = await fetch(BASE_URL, { headers: FETCH_HEADERS });

      if (!response.ok) {
        console.error(`The Skint fetch failed (${response.status})`);
        return [];
      }

      const html = await response.text();
      console.log(`The Skint HTML: ${html.length} chars`);

      const events = await parseEventsFromHtml(html, "theskint", BASE_URL, apiKey);
      console.log(`The Skint: parsed ${events.length} events`);

      return events;
    },
  };
}
