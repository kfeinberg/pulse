import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromHtml } from "../../services/parser.js";

const BASE_URL = "https://ny-event-radar.com/";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

export function createNYEventRadarScraper(
  apiKey: string,
  scrapingBeeKey?: string
): EventSource {
  return {
    name: "nyeventradar",
    async scrape(): Promise<ScrapedEvent[]> {
      let html: string;

      if (scrapingBeeKey) {
        // NY Event Radar is a React app — needs JS rendering
        console.log(`Fetching NY Event Radar via ScrapingBee: ${BASE_URL}`);
        const params = new URLSearchParams({
          api_key: scrapingBeeKey,
          url: BASE_URL,
          render_js: "true",
          wait: "5000",
          block_ads: "true",
          js_scenario: JSON.stringify({
            instructions: [
              { wait: 5000 },
              { scroll_y: 2000 },
              { wait: 3000 },
              { scroll_y: 4000 },
              { wait: 3000 },
            ],
          }),
        });

        const response = await fetch(
          `https://app.scrapingbee.com/api/v1?${params.toString()}`
        );

        if (!response.ok) {
          const body = await response.text();
          console.error(`ScrapingBee failed for NY Event Radar (${response.status}): ${body.slice(0, 200)}`);
          return [];
        }

        html = await response.text();
      } else {
        // Fallback: try direct fetch (may have limited content)
        console.log(`Fetching NY Event Radar directly: ${BASE_URL}`);
        const response = await fetch(BASE_URL, { headers: FETCH_HEADERS });
        if (!response.ok) {
          console.error(`NY Event Radar failed: ${response.status}`);
          return [];
        }
        html = await response.text();
      }

      console.log(`NY Event Radar HTML: ${html.length} chars`);

      if (html.length < 1000) {
        console.error(`NY Event Radar HTML too short: ${html.slice(0, 500)}`);
        return [];
      }

      const events = await parseEventsFromHtml(html, "nyeventradar", BASE_URL, apiKey);
      console.log(`NY Event Radar: Claude extracted ${events.length} events`);
      return events;
    },
  };
}
