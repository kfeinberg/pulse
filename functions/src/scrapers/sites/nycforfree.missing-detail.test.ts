import assert from "node:assert/strict";
import test from "node:test";
import type { ScrapedEvent } from "../base.js";
import { ExtractionCache, type SeenItemStore } from "../../services/extractionCache.js";
import { parseEventTimes } from "../../services/parser.js";
import { createNycForFreeScraper, parseWebflowEvents } from "./nycforfree.js";

const BASE = "https://www.nycforfree.co/events";
const listing = `<div class="w-dyn-item" title="Shine Bright at Hudson Yards 2026" slug="shine-bright-at-hudson-yards" start-date="November 16, 2026" end-date="January 7, 2027" start-time="8:00 AM" end-time="10:45 PM" address="20 Hudson Yards, New York, NY 10001" borough="Manhattan" frequency="One-time" description="A temporary holiday display running November 16 through January 7…" lat="40.754" long="-74.002"></div>`;
const source = parseWebflowEvents(listing)[0];
const template: ScrapedEvent = {
  title: source.title, description: source.description, location: source.address,
  ...parseEventTimes(source.startDate, source.startTime, source.endTime),
  sourceUrl: `${BASE}/${source.slug}`, sourceName: "nycforfree", category: "happening",
  temporalStatus: "limited_run", temporalEvidence: "Temporary holiday display running November 16 through January 7",
};
function cache() {
  const keys = new Set<string>();
  const store: SeenItemStore = { findExisting: async (ids) => new Set(ids.filter((id) => keys.has(id))), save: async (ids) => { ids.forEach((id) => keys.add(id)); } };
  return { next: () => new ExtractionCache("nycforfree", { store }), keys };
}
function response(body: string, status: number, url?: string): Response {
  const result = new Response(body, { status });
  if (url) Object.defineProperty(result, "url", { value: url });
  return result;
}

for (const missing of ["listing redirect", "listing slash redirect", "404", "410"]) {
  test(`a still-published card survives ${missing} without using a redirected body or caching the unavailable detail`, async () => {
    const state = cache();
    let calls = 0;
    const scraper = createNycForFreeScraper("unused", {
      fetch: async (input) => String(input) === BASE ? new Response(listing) :
        missing === "listing redirect" ? response("UNRELATED REDIRECTED LISTING CONTENT", 200, BASE) :
        missing === "listing slash redirect" ? response("UNRELATED REDIRECTED LISTING CONTENT", 200, `${BASE}/`) :
        response("UNRELATED NOT-FOUND BODY", Number(missing), `${BASE}/${source.slug}`),
      extract: async (content) => {
        calls++;
        assert.match(content, /Detail unavailable/);
        assert.match(content, /Temporary holiday display|temporary holiday display/);
        assert.doesNotMatch(content, /UNRELATED/);
        return [template];
      },
    });
    const firstCache = state.next();
    const first = await scraper.scrape(firstCache);
    assert.equal(first.length, 1);
    assert.equal(first[0].endTimestamp, Date.parse("2027-01-08T03:45:00Z"));
    assert.equal(first[0].sourceLocation?.address, source.address);
    assert.deepEqual(firstCache.stagedKeys, []);
    await firstCache.commit();
    assert.equal(state.keys.size, 0);
    await scraper.scrape(state.next());
    assert.equal(calls, 2, "an unavailable detail must be retried on the next run");
  });
}

test("permission errors, server outages and unexpected/off-site redirects never get the missing-detail fallback", async () => {
  for (const failure of [403, 503, "off-site", "other-detail", "redirect-403", "redirect-503"]) {
    const state = cache();
    let modelCalls = 0;
    const scraper = createNycForFreeScraper("unused", {
      fetch: async (input) => {
        if (String(input) === BASE) return new Response(listing);
        if (failure === "redirect-403" || failure === "redirect-503") return response("Listing denied/unavailable", Number(failure.slice(-3)), BASE);
        return typeof failure === "number" ? response("Denied", failure, `${BASE}/${source.slug}`) :
          response("Other content", 404, failure === "off-site" ? "https://example.com/events" : `${BASE}/other-event`);
      },
      extract: async () => { modelCalls++; return [template]; },
    });
    await assert.rejects(scraper.scrape(state.next()));
    assert.equal(modelCalls, 0);
    assert.equal(state.keys.size, 0);
  }
});

test("a missing listing still fails instead of pretending that there are zero events", async () => {
  await assert.rejects(createNycForFreeScraper("unused", { fetch: async () => response("Not found", 404, BASE), extract: async () => [] }).scrape(cache().next()), /fetch failed/);
});

test("unavailable detail metadata does not bypass intentional temporal exclusions", async () => {
  const state = cache();
  const result = await createNycForFreeScraper("unused", { fetch: async (input) => String(input) === BASE ? new Response(listing) : response("Not found", 404), extract: async () => [] }).scrape(state.next());
  assert.deepEqual(result, []);
  assert.equal(state.keys.size, 0);
});
