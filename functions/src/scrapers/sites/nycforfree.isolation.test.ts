import assert from "node:assert/strict";
import test from "node:test";
import type { ScrapedEvent } from "../base.js";
import { ExtractionCache, itemKey, type SeenItemStore } from "../../services/extractionCache.js";
import { parseEventTimes } from "../../services/parser.js";
import { createNycForFreeScraper, parseWebflowEvents, readWebflowCards, toText, type WebflowEvent } from "./nycforfree.js";

// One ambiguous, malformed or unreachable card must cost only that card. The
// strict per-card rules are exercised in nycforfree.test.ts; these fixtures
// check that every other card still publishes and that the bad card is never
// staged (so it is retried) and is recorded in the run's failures.
const BASE_URL = "https://www.nycforfree.co/events";
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function card(overrides: Record<string, string> = {}, children = ""): string {
  const attrs = {
    class: "w-dyn-item", title: "Temporary Pop-Up", slug: "temporary-pop-up",
    "start-date": "November 13, 2026", "end-date": "November 13, 2026",
    "start-time": "10:00 AM", "end-time": "7:00 PM", address: "423 West 14th Street, New York, NY, USA",
    borough: "Manhattan", frequency: "One-time", category: "Fashion", description: "A free temporary event.",
    lat: "40.7417079", long: "-74.0064341", ...overrides,
  };
  return `<div ${Object.entries(attrs).map(([key, value]) => `${key}="${escape(value)}"`).join(" ")}><a href="/events/${attrs.slug}">${children}</a></div>`;
}
const turkeyLocations = { locations: [
  { address: "25-29 Steinway Street, Queens, NY 11103", borough: "Queens", lat: 40.7671163, lng: -73.9120854 },
  { address: "711 Lydig Avenue, The Bronx, NY 10462", borough: "The Bronx", lat: 40.8546476, lng: -73.8670443 },
] };
const ambiguousAttrs = {
  title: "SAVE A TURKEY. EAT CHICKEN!", slug: "save-a-turkey-eat-chicken", frequency: "Multiple Dates",
  "start-date": "November 20, 2026", "end-date": "November 21, 2026", description: "Independent dates and venues; pairing unspecified.",
};
const ambiguousChildren = `<div event-data="locations">${escape(JSON.stringify(turkeyLocations))}</div><div event-data="occurrences">2026-11-20|19:00|22:00,2026-11-21|18:00|22:00</div>`;
const goodAttrs = { title: "Good Pop-Up", slug: "good-pop-up" };

function extracted(event: WebflowEvent, overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    title: event.title, description: "A source-backed temporary event.",
    ...parseEventTimes(event.startDate, event.startTime, event.endTime),
    location: event.locations[0]?.address ?? event.address, category: "popup",
    sourceUrl: `${BASE_URL}/${event.slug}`, sourceName: "nycforfree", temporalStatus: "scheduled_event",
    temporalEvidence: "The source lists an explicit date.", ...overrides,
  };
}
function memoryCache(existing = new Set<string>()) {
  const store: SeenItemStore = {
    async findExisting(keys) { return new Set(keys.filter((key) => existing.has(key))); },
    async save(keys) { keys.forEach((key) => existing.add(key)); },
  };
  return new ExtractionCache("nycforfree", { store });
}
function pages(map: Record<string, string | number>): typeof fetch {
  return async (input) => {
    const value = map[String(input)];
    assert.notEqual(value, undefined, `Unexpected request: ${String(input)}`);
    return new Response(typeof value === "number" ? "Failed" : value, { status: typeof value === "number" ? value : 200 });
  };
}
// The model returns one template per source card it was shown.
function modelFor(sources: WebflowEvent[]) {
  const seen: string[] = [];
  return {
    seen,
    extract: async (text: string) => sources.filter((source) => text.includes(`URL: ${BASE_URL}/${source.slug}`)).map((source) => {
      seen.push(source.slug);
      return extracted(source);
    }),
  };
}

test("an ambiguous card no longer hides the other cards on the listing", async () => {
  const listing = card(goodAttrs) + card(ambiguousAttrs, ambiguousChildren);
  const [good, ambiguous] = parseWebflowEvents(listing);
  const cache = memoryCache();
  const model = modelFor([good, ambiguous]);
  const result = await createNycForFreeScraper("unused", { fetch: pages({ [BASE_URL]: listing }), extract: model.extract }).scrape(cache);
  assert.deepEqual(result.map((event) => event.sourceUrl), [`${BASE_URL}/good-pop-up`]);
  assert.deepEqual(cache.stagedKeys, [itemKey("nycforfree", toText(good))]);
  assert.equal(cache.failureReasons.length, 1);
  assert.match(cache.failureReasons[0], /save-a-turkey-eat-chicken/);
});

test("a failing detail page holds back only its own card, before any model work on it", async () => {
  const truncated = { slug: "needs-detail", title: "Needs Detail", description: "A truncated pop-up…" };
  const listing = card(goodAttrs) + card(truncated);
  const [good] = parseWebflowEvents(listing);
  const cache = memoryCache();
  const model = modelFor(parseWebflowEvents(listing));
  const result = await createNycForFreeScraper("unused", {
    fetch: pages({ [BASE_URL]: listing, [`${BASE_URL}/needs-detail`]: 503 }), extract: model.extract,
  }).scrape(cache);
  assert.deepEqual(result.map((event) => event.title), ["Good Pop-Up"]);
  assert.deepEqual(model.seen, ["good-pop-up"]);
  assert.deepEqual(cache.stagedKeys, [itemKey("nycforfree", toText(good))]);
  assert.match(cache.failureReasons.join("\n"), /fetch failed \(503\)/);
});

test("a malformed card is reported on its own and the rest of the listing still parses", () => {
  const listing = card(goodAttrs) + card({ slug: "broken-card", title: "Broken" }, '<div event-data="occurrences">{broken</div>');
  const { events, failures } = readWebflowCards(listing);
  assert.deepEqual(events.map((event) => event.slug), ["good-pop-up"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].slug, "broken-card");
  assert.match(failures[0].error.message, /occurrences JSON/);
  // The strict parser keeps its fail-closed contract for direct callers.
  assert.throws(() => parseWebflowEvents(listing), /occurrences JSON/);
  // Conflicting duplicates drop that slug entirely rather than picking one.
  const conflict = readWebflowCards(card(goodAttrs) + card() + card({ address: "89 E 42nd St" }));
  assert.deepEqual(conflict.events.map((event) => event.slug), ["good-pop-up"]);
  assert.match(conflict.failures[0].error.message, /Conflicting/);
});

test("when every fresh card fails and nothing was already extracted, the source still fails", async () => {
  const listing = card(ambiguousAttrs, ambiguousChildren) + card({ ...ambiguousAttrs, slug: "second-ambiguous", title: "Second" }, ambiguousChildren);
  const cards = parseWebflowEvents(listing);
  const cache = memoryCache();
  await assert.rejects(createNycForFreeScraper("unused", { fetch: pages({ [BASE_URL]: listing }), extract: modelFor(cards).extract }).scrape(cache), /binding/);
  assert.deepEqual(cache.stagedKeys, []);
});

test("one failing new card next to already-extracted cards is not a source outage", async () => {
  const listing = card(goodAttrs) + card(ambiguousAttrs, ambiguousChildren);
  const [good, ambiguous] = parseWebflowEvents(listing);
  const cache = memoryCache(new Set([itemKey("nycforfree", toText(good))]));
  const model = modelFor([good, ambiguous]);
  const result = await createNycForFreeScraper("unused", { fetch: pages({ [BASE_URL]: listing }), extract: model.extract }).scrape(cache);
  assert.deepEqual(result, []);
  assert.equal(cache.skipped, 1);
  assert.deepEqual(cache.stagedKeys, []);
  assert.match(cache.failureReasons.join("\n"), /binding/);
});
