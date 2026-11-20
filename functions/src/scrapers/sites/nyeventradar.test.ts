import assert from "node:assert/strict";
import test from "node:test";
import type { ScrapedEvent } from "../base.js";
import { ExtractionCache, itemKey, type SeenItemStore } from "../../services/extractionCache.js";
import { parseEventTimes } from "../../services/parser.js";
import { createNYEventRadarScraper, getDateString } from "./nyeventradar.js";

function memoryCache() {
  const saved = new Set<string>();
  const store: SeenItemStore = {
    async findExisting(keys) { return new Set(keys.filter((key) => saved.has(key))); },
    async save(keys) { keys.forEach((key) => saved.add(key)); },
  };
  return new ExtractionCache("nyeventradar", { store });
}

const rows = [
  { id: "1", title: "Fall Gala", description: "Benefit", start_date: "2026-11-21", start_time: "19:00", location: "Gala Hall", address: "10 Main St, Brooklyn, NY", url: "https://www.eventbrite.com/e/fall-gala" },
  { id: "2", title: "Jazz Night", description: "Trio", start_date: "2026-11-21", start_time: "20:00", location: "Jazz Club", address: "20 Main St, Brooklyn, NY", url: "https://example.com/jazz" },
];

function scraped(title: string, sourceUrl: string): ScrapedEvent {
  return {
    title, description: "Fixture", ...parseEventTimes("2026-11-21", "19:00", "22:00"), location: "10 Main St, Brooklyn, NY",
    category: "happening", sourceUrl, sourceName: "nyeventradar", temporalStatus: "scheduled_event", temporalEvidence: "November 21 at 7pm",
  };
}

test("the query window follows New York dates, not UTC dates", () => {
  // 11:30pm ET on Nov 20 is already Nov 21 in UTC.
  assert.equal(getDateString(0, Date.parse("2026-11-21T04:30:00Z")), "2026-11-20");
  assert.equal(getDateString(3, Date.parse("2026-11-21T04:30:00Z")), "2026-11-23");
});

test("a refused Eventbrite lookup costs one deep link, not every NY Event Radar event", async () => {
  const cache = memoryCache();
  const requests: string[] = [];
  let content = "";
  const scraper = createNYEventRadarScraper("unused", {
    now: () => Date.parse("2026-11-20T15:00:00Z"),
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("https://ropievbxucezuacvgpbk.supabase.co/")) return Response.json(rows);
      if (url.startsWith("https://www.eventbrite.com/d/")) return new Response("Method Not Allowed", { status: 405 });
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch,
    extract: async (text) => {
      content = text;
      return [scraped("Fall Gala", "https://ny-event-radar.com/"), scraped("Jazz Night", "https://example.com/jazz")];
    },
  });
  const events = await scraper.scrape(cache);
  assert.deepEqual(events.map((event) => event.sourceUrl), ["https://ny-event-radar.com/", "https://example.com/jazz"]);
  assert.ok(requests.some((url) => url.includes("start_date.gte.2026-11-20")));
  // The unusable link never reaches the model, and only the affected item stays unstaged.
  assert.doesNotMatch(content, /eventbrite/);
  assert.equal(cache.stagedKeys.length, 1);
  assert.match(cache.failureReasons.join("\n"), /Eventbrite URL resolution failed for "Fall Gala"/);
  const jazzText = content.split("\n\n---\n\n").find((item) => item.includes("Jazz Night"))!;
  assert.deepEqual(cache.stagedKeys, [itemKey("nyeventradar", jazzText)]);
});
