import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromText } from "../../services/parser.js";

const EXPLORE_URL = "https://posh.vip/explore";

async function fetchRenderedHtml(
  url: string,
  scrapingBeeKey: string
): Promise<string> {
  const params = new URLSearchParams({
    api_key: scrapingBeeKey,
    url,
    render_js: "true",
    wait: "5000",
    premium_proxy: "true",
    stealth_proxy: "true",
    block_ads: "true",
    js_scenario: JSON.stringify({
      instructions: [
        { wait: 5000 },
        { scroll_y: 2000 },
        { wait: 3000 },
        { scroll_y: 4000 },
        { wait: 3000 },
        { scroll_y: 6000 },
        { wait: 3000 },
        { scroll_y: 8000 },
        { wait: 3000 },
      ],
    }),
  });

  const response = await fetch(
    `https://app.scrapingbee.com/api/v1?${params.toString()}`
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ScrapingBee failed (${response.status}): ${body.slice(0, 200)}`
    );
  }

  return response.text();
}

// Lightweight text extraction that preserves rendered content
function extractText(html: string): string {
  let cleaned = html;

  // Remove script tags and contents
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  // Remove style tags and contents
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  // Remove SVG blocks
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, " ");
  // Preserve links: convert <a href="url">text</a> to text (url)
  cleaned = cleaned.replace(
    /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `${text.replace(/<[^>]+>/g, "")} (${href})`
  );
  // Remove all remaining tags but keep text
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  // Decode entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

export function createPoshScraper(
  apiKey: string,
  scrapingBeeKey: string
): EventSource {
  return {
    name: "posh",
    async scrape(): Promise<ScrapedEvent[]> {
      console.log(`Fetching Posh explore page via ScrapingBee: ${EXPLORE_URL}`);

      const html = await fetchRenderedHtml(EXPLORE_URL, scrapingBeeKey);
      console.log(`Posh rendered HTML: ${html.length} chars`);

      if (html.length < 1000) {
        console.error(`Posh HTML too short, likely failed: ${html.slice(0, 500)}`);
        return [];
      }

      const text = extractText(html);
      console.log(`Posh extracted text: ${text.length} chars`);
      console.log(`Text preview: ${text.slice(0, 500)}`);

      if (text.length < 100) {
        console.error("Posh text extraction produced too little content");
        return [];
      }

      const events = await parseEventsFromText(
        text,
        "posh",
        EXPLORE_URL,
        apiKey
      );
      console.log(`Claude extracted ${events.length} events from Posh`);

      return events;
    },
  };
}
