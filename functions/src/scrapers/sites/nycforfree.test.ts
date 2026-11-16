import assert from "node:assert/strict";
import test from "node:test";
import type { ScrapedEvent } from "../base.js";
import { ExtractionCache, itemKey, type SeenItemStore } from "../../services/extractionCache.js";
import { parseEventTimes } from "../../services/parser.js";
import { createNycForFreeScraper, overlayNycForFreeEvents, parseWebflowEvents, toText, type WebflowEvent, type NycForFreeDependencies } from "./nycforfree.js";

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
  return `<div ${Object.entries(attrs).map(([key, value]) => `${key}="${escape(value)}"`).join(" ")}><a href="/events/${attrs.slug}"><div><div>Nested visual content</div></div>${children}</a></div>`;
}
function source(overrides: Record<string, string> = {}, children = ""): WebflowEvent {
  return parseWebflowEvents(card(overrides, children))[0];
}
function extracted(event: WebflowEvent, overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    title: event.title, description: "A source-backed temporary event.",
    ...parseEventTimes(event.startDate, event.startTime, event.endTime),
    location: "423 East 14th Street, New York, NY", category: "popup",
    sourceUrl: `${BASE_URL}/${event.slug}`, sourceName: "nycforfree", temporalStatus: "limited_run",
    temporalEvidence: "The source announces a temporary pop-up with explicit dates.", ...overrides,
  };
}
function memoryCache() {
  const existing = new Set<string>();
  const saved: string[][] = [];
  const store: SeenItemStore = {
    async findExisting(keys) { return new Set(keys.filter((key) => existing.has(key))); },
    async save(keys) { saved.push(keys); keys.forEach((key) => existing.add(key)); },
  };
  return { existing, saved, cache: () => new ExtractionCache("nycforfree", { store }) };
}
function fakeFetch(pages: Record<string, string | number>, calls: string[] = []): typeof fetch {
  return async (input, init) => {
    assert.ok(init?.signal, "every request must have a timeout signal");
    const url = String(input);
    calls.push(url);
    const value = pages[url];
    assert.notEqual(value, undefined, `Unexpected request: ${url}`);
    return new Response(typeof value === "number" ? "Failed" : value, { status: typeof value === "number" ? value : 200 });
  };
}
const detail = (address: string, description: string, extra = "") => `<main><div event-data="start-date">November 13, 2026</div><div class="event_description-rt w-richtext"><p>${description}</p><div><strong>Full nested about text</strong></div></div><div class="event-details_map" data-place="Real Source Venue" data-address="${address}" data-lat="40.7417079" data-long="-74.0064341"></div>${extra}</main>`;

test("balanced Webflow children preserve hidden fields beyond nested divs and ignore scripts/navigation", () => {
  const html = `<div class="w-dyn-item"><a>Navigation</a></div><script>${card({ slug: "fake-in-script" })}</script>` + card({ title: "Flowers &amp; Trains &#x1F682;" }, `<div><div>before</div><div event-data="occurrences">2026-11-13|11:00|19:00,2026-11-15|11:00|17:00</div></div><div event-data="locations">${escape(JSON.stringify({ locations: [{ name: "Grand Central", address: "89 East 42nd Street, New York, NY 10017", lat: 40.7531633, lng: -73.9771039 }] }))}</div>`);
  const events = parseWebflowEvents(html);
  assert.equal(events.length, 1);
  assert.equal(events[0].occurrences[1].endTime, "17:00");
  assert.equal(events[0].locations[0].name, "Grand Central");
  assert.equal(events[0].locations[0].longitude, -73.9771039);
  assert.match(events[0].title, /Flowers/);
});

test("single-quoted attributes and safe entity decoding handle nested child text", () => {
  const html = `<div class='w-dyn-item' title='Coffee &amp; Tea &#x1F682;' slug='coffee-and-tea' start-date='2026-11-13' address='Broome Street and West Broadway'><div event-data='description'><p>Welcome &amp; enjoy &#39;coffee&#39; &#1114112;</p></div></div>`;
  const event = parseWebflowEvents(html)[0];
  assert.equal(event.title, "Coffee & Tea 🚂");
  assert.equal(event.description, "Welcome & enjoy 'coffee' �");
});

test("occurrences support source JSON objects/dateKeys and optional explicit endDate", () => {
  const objects = source({}, `<div event-data="occurrences">${escape(JSON.stringify({ occurrences: [{ date: "2026-11-13", startTime: "11:00", endTime: "17:00", endDate: "2026-11-14" }] }))}</div>`);
  assert.deepEqual(objects.occurrences, [{ date: "2026-11-13", startTime: "11:00", endTime: "17:00", endDate: "2026-11-14" }]);
  const dateKeys = source({}, `<div event-data="occurrences">${escape(JSON.stringify({ dateKeys: ["2026-11-13", "2026-11-15"] }))}</div>`);
  assert.equal(dateKeys.occurrences[1].startTime, "10:00");
});

test("malformed occurrence payloads fail closed instead of inventing fallback dates", () => {
  for (const payload of ["{broken", '{"occurrences":[]}', "2026-11-13|eleven|19:00", "2026-02-30|11:00|17:00", "2026-11-13|11:00", '[{"date":"2026-11-13","startTime":7}]', '[{"date":"2026-11-13","endDate":"2026-11-12"}]']) {
    assert.throws(() => source({}, `<div event-data="occurrences">${escape(payload)}</div>`));
  }
  assert.throws(() => source({ "recurring-days": "Someday" }), /recurring days/);
  assert.throws(() => source({}, '<div event-data="locations">not-json</div>'), /locations JSON/);
});

test("duplicate slugs conflict rather than silently replacing one source card", () => {
  assert.equal(parseWebflowEvents(card() + card()).length, 1);
  assert.throws(() => parseWebflowEvents(card() + card({ address: "89 E 42nd St" })), /Conflicting/);
});

for (const sample of [
  { title: "New York Transit Museum Holiday Train Show 2026", slug: "new-york-transit-museum-holiday-train-show-2026", start: "November 13, 2026", end: "February 21, 2027", time: "6:00 PM", expected: "2027-02-21T23:00:00Z" },
  { title: "Flower Knows Snow Ballet Atelier", slug: "flower-knows-snow-ballet-atelier", start: "November 13, 2026", end: "November 15, 2026", time: "7:00 PM", expected: "2026-11-16T00:00:00Z" },
  { title: "Toybox 3D Printer Pop-Up Event @ Grand Central", slug: "toybox-3d-printer-pop-up-event-grand-central", start: "November 11, 2026", end: "November 21, 2026", time: "7:00 PM", expected: "2026-11-22T00:00:00Z" },
]) {
  test(`${sample.title} remains a bounded continuous run through its source end day`, () => {
    const event = source({ title: sample.title, slug: sample.slug, "start-date": sample.start, "end-date": sample.end, "end-time": sample.time });
    const first = overlayNycForFreeEvents([event], [extracted(event)]);
    assert.equal(first.length, 1);
    assert.equal(first[0].endTimestamp, Date.parse(sample.expected));
    assert.equal(first[0].temporalStatus, "limited_run");
    assert.equal(first[0].location, event.address);
    assert.equal(first[0].sourceLocation?.address, event.address);
    const corrected = { ...event, endDate: "2027-02-22" };
    const updated = overlayNycForFreeEvents([corrected], [extracted(corrected)]);
    assert.equal(updated[0].sourceOccurrenceId, first[0].sourceOccurrenceId, "end-date fixes update the same run identity");
  });
}

test("PINK one-night party is not widened to its larger CMS date envelope", () => {
  const event = source({ title: "PINK Patch Party", slug: "pink-patch-party", "start-date": "November 12, 2026", "end-date": "November 14, 2026", description: "Join the patch party on November 12 from 6 to 8 PM." });
  const oneNight = extracted(event, { temporalStatus: "scheduled_event", ...parseEventTimes("2026-11-12", "18:00", "20:00") });
  const [result] = overlayNycForFreeEvents([event], [oneNight]);
  assert.equal(result.startTimestamp, oneNight.startTimestamp);
  assert.equal(result.endTimestamp, oneNight.endTimestamp);
  assert.equal(result.temporalStatus, "scheduled_event");
});

test("UGG One-time envelope does not turn classified discrete gifting dates into a continuous run", () => {
  const event = source({ title: "UGG Holiday Cheer Activation", slug: "ugg-holiday-cheer", "start-date": "November 5, 2026", "end-date": "December 24, 2026", description: "Gingerbread Cookie Gift November5. Sweater cookies December4." });
  const sessions = ["2026-11-05", "2026-12-04"].map((date) => extracted(event, { temporalStatus: "scheduled_event", ...parseEventTimes(date, "10:00", "19:00") }));
  const results = overlayNycForFreeEvents([event], sessions);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((result) => result.endTimestamp), sessions.map((session) => session.endTimestamp));
});

test("source venue names are retained, but place-name corrections do not change source occurrence identity", () => {
  const event = source({ place: "Roebling Rink", address: "Emily Warren Roebling Plaza, Brooklyn Bridge Park, Brooklyn, NY" });
  const [result] = overlayNycForFreeEvents([event], [extracted(event)]);
  assert.equal(result.location, `Roebling Rink, ${event.address}`);
  assert.equal(result.sourceLocation?.placeName, "Roebling Rink");
  const updated = { ...event, locations: [{ ...event.locations[0], name: "Roebling Rink at Brooklyn Bridge Park" }] };
  const [corrected] = overlayNycForFreeEvents([updated], [extracted(updated)]);
  assert.equal(result.sourceOccurrenceId, corrected.sourceOccurrenceId);
});

test("normalized trusted detail URLs keep exact source identity without tracking query strings", () => {
  const event = source();
  for (const sourceUrl of [`https://nycforfree.co/events/${event.slug}/?utm_source=test#details`, `/events/${event.slug}`]) {
    const [result] = overlayNycForFreeEvents([event], [extracted(event, { sourceUrl, title: `${event.title} (Opening Night)` })]);
    assert.equal(result.sourceUrl, `${BASE_URL}/${event.slug}`);
  }
});

test("placeholder source addresses cannot replace a model's specific event location", () => {
  for (const address of ["N/A", "unknown", "none", "not specified", "location", "address"]) {
    const event = source({ address });
    const [result] = overlayNycForFreeEvents([event], [extracted(event)]);
    assert.equal(result.location, extracted(event).location);
    assert.equal(result.sourceLocation, undefined);
  }
});

test("source West14 address overrides model East14, and only actual source coordinates survive", () => {
  const event = source();
  const [result] = overlayNycForFreeEvents([event], [extracted(event, { latitude: 1, longitude: 2, sourceLocation: { latitude: 9, longitude: 9, address: "Fake model address", sourceUrl: `${BASE_URL}/${event.slug}` } })]);
  assert.equal(result.location, "423 West 14th Street, New York, NY, USA");
  assert.equal(result.sourceLocation?.latitude, 40.7417079);
  assert.equal(result.sourceLocation?.sourceUrl, result.sourceUrl);
  assert.equal(result.latitude, undefined);
  assert.equal(result.longitude, undefined);
});

test("Hunger Games expands exactly three explicit occurrences, with last day's5pm close", () => {
  const event = source({ title: "The Hunger Games: Sunrise on the Reaping (The Album) Pop-Up", slug: "the-hunger-games-pop-up", frequency: "Multiple Dates", "end-date": "November 15, 2026", address: "620 Broadway, New York, NY 10012" }, '<div event-data="occurrences">2026-11-13|11:00|19:00,2026-11-14|11:00|19:00,2026-11-15|11:00|17:00</div>');
  const result = overlayNycForFreeEvents([event], [extracted(event)]);
  assert.equal(result.length, 3);
  assert.equal(result[2].endTimestamp, Date.parse("2026-11-15T22:00:00Z"));
  assert.ok(result.every((candidate) => candidate.temporalStatus === "scheduled_event"));
  assert.equal(new Set(result.map((candidate) => candidate.sourceOccurrenceId)).size, 3);
});

test("Broadway Thursday and Nostalgia Sunday rules expand only explicit weekdays", () => {
  const thursday = source({ title: "Broadway Under The Stars", slug: "broadway-under-the-stars", "start-date": "November 12, 2026", "end-date": "December 17, 2026", "start-time": "5:00 PM", "end-time": "6:00 PM", frequency: "Recurrent", "recurring-days": "Thu" });
  const results = overlayNycForFreeEvents([thursday], [extracted(thursday)]);
  assert.equal(results.length, 6);
  assert.ok(results.every((event) => new Date(event.startTimestamp).getUTCDay() === 4));
  assert.equal(results.at(-1)?.endTimestamp, Date.parse("2026-12-17T23:00:00Z"));
  const sunday = source({ frequency: "Recurrent", "recurring-days": "Sun", "start-date": "November 29, 2026", "end-date": "December 27, 2026" });
  assert.equal(overlayNycForFreeEvents([sunday], [extracted(sunday)]).length, 5);
});

test("all-days Continuous is kept as one limited run rather than daily duplicates", () => {
  const event = source({ frequency: "Continuous", "recurring-days": "Sun,Mon,Tue,Wed,Thu,Fri,Sat", "end-date": "December 26, 2026" });
  assert.equal(overlayNycForFreeEvents([event], [extracted(event)]).length, 1);
});

test("source CoffeeTruck intersection and Roebling source place are eligible pins", () => {
  for (const address of ["Broome Street and West Broadway", "Roebling Rink at Brooklyn Bridge Park, Emily Warren Roebling Plaza, Brooklyn, NY, USA"]) {
    const event = source({ address, lat: "40.7233478", long: "-74.002963" });
    const [result] = overlayNycForFreeEvents([event], [extracted(event)]);
    assert.equal(result.location, address);
    assert.equal(result.sourceLocation?.address, address);
  }
});

test("Jazz W11th keeps its specific address but rejects the listing's NYC centroid", () => {
  const jazz = source({ title: "Jazz Nights in the West Village", slug: "jazz-nights-in-the-west-village", address: "232 W11th Street, NYC, 10014", lat: "40.7127753", long: "-74.0059728" });
  const [result] = overlayNycForFreeEvents([jazz], [extracted(jazz)]);
  assert.equal(result.location, "232 W11th Street, NYC, 10014");
  assert.equal(result.sourceLocation, undefined);
});

test("generic, invalid, or out-of-viewbox coordinates never become trusted source pins", () => {
  for (const overrides of [
    { address: "New York, NY, USA" }, { address: "NYC 10014" }, { address: "Various locations across NYC" },
    { lat: "not-a-number" }, { lat: "40.9750921", long: "-73.8325475" }, { long: "Infinity" },
  ] as Record<string, string>[]) {
    const event = source(overrides);
    const [result] = overlayNycForFreeEvents([event], [extracted(event)]);
    assert.equal(result.sourceLocation, undefined);
  }
});

test("same20-character title prefixes do not map, and wrong detail URLs cannot fall back to titles", () => {
  const first = source({ title: "The very long shared title - Queens", slug: "shared-title-queens" });
  const second = source({ title: "The very long shared title - Bronx", slug: "shared-title-bronx" });
  assert.throws(() => overlayNycForFreeEvents([first, second], [extracted(first, { sourceUrl: BASE_URL, title: "The very long shared title" })]), /unmatched/);
  assert.throws(() => overlayNycForFreeEvents([first], [extracted(first, { sourceUrl: `${BASE_URL}/wrong-detail` })]), /Unmatched/);
  assert.throws(() => overlayNycForFreeEvents([first], [extracted(first, { sourceUrl: "https://attacker.example/events/shared-title-queens" })]), /Unmatched/);
  const [exact] = overlayNycForFreeEvents([first, second], [extracted(first, { title: "The very long shared title - Queens (Opening Night)" })]);
  assert.equal(exact.sourceUrl, `${BASE_URL}/shared-title-queens`);
  assert.equal(overlayNycForFreeEvents([first], [extracted(first, { sourceUrl: BASE_URL, title: first.title.toUpperCase() })]).length, 1);
  assert.throws(() => overlayNycForFreeEvents([first, { ...second, title: first.title }], [extracted(first, { sourceUrl: BASE_URL })]), /Ambiguous/);
});

test("multiple dates+locations retain exact model-backed pairs, never their Cartesian product", () => {
  const locations = { locations: [
    { name: null, address: "25-29 Steinway Street, Queens, NY 11103", lat: 40.7671163, lng: -73.9120854, borough: "Queens" },
    { name: null, address: "711 Lydig Avenue, The Bronx, NY 10462", lat: 40.8546476, lng: -73.8670443, borough: "The Bronx" },
  ] };
  const event = source({ title: "SAVE A TURKEY. EAT CHICKEN!", slug: "save-a-turkey-eat-chicken", frequency: "Multiple Dates", "start-date": "November 20, 2026", "end-date": "November 21, 2026", description: "Steinway – Nov 20 | 7 PM. Bronx – Nov 21 | 6 PM." }, `<div event-data="locations">${escape(JSON.stringify(locations))}</div><div event-data="occurrences">2026-11-20|19:00|22:00,2026-11-21|18:00|22:00</div>`);
  const queens = extracted(event, { location: locations.locations[0].address, ...parseEventTimes("2026-11-20", "19:00", "22:00") });
  const bronx = extracted(event, { location: locations.locations[1].address, ...parseEventTimes("2026-11-21", "18:00", "22:00") });
  const result = overlayNycForFreeEvents([event], [queens, bronx]);
  assert.equal(result.length, 2);
  assert.equal(result[0].location, queens.location);
  assert.equal(result[1].startTimestamp, Date.parse("2026-11-21T23:00:00Z"));
  assert.equal(result[1].sourceLocation?.latitude, 40.8546476);
  const recovered = overlayNycForFreeEvents([event], [queens]);
  assert.equal(recovered.length, 2, "one classified template recovers both literal source-backed stops, not four");
  const wrongPair = extracted(event, { location: queens.location, ...parseEventTimes("2026-11-21", "18:00", "22:00") });
  const corrected = overlayNycForFreeEvents([event], [wrongPair]);
  assert.equal(corrected.length, 2);
  assert.equal(corrected[0].location, queens.location);
  assert.equal(corrected[0].startTimestamp, queens.startTimestamp);
  assert.equal(corrected[1].location, bronx.location);
  assert.equal(corrected[1].sourceLocation?.latitude, 40.8546476);
  assert.throws(() => overlayNycForFreeEvents([{ ...event, description: "Dates and locations independently listed, without any binding." }], [queens]), /binding/);
});

test("multi-location matching accepts unique full street cores without ZIP or venue formatting, but never house-number prefixes", () => {
  const locations = { locations: [
    { name: "UGG Fifth Avenue", address: "530 Fifth Avenue, New York, NY 10036", borough: "Manhattan", lat: 40.7551805, lng: -73.9798802 },
    { name: "UGG Soho", address: "79 Mercer Street, New York, NY 10012, USA", borough: "Manhattan", lat: 40.7228732, lng: -74.0003615 },
  ] };
  const event = source({ title: "UGG Holiday Cheer Activation", slug: "ugg-holiday-cheer" }, `<div event-data="locations">${escape(JSON.stringify(locations))}</div>`);
  for (const location of ["530 Fifth Avenue, New York, NY, Manhattan", "UGG Fifth Avenue, 530 Fifth Ave, New York", "79 Mercer St, New York, NY"]) {
    const [result] = overlayNycForFreeEvents([event], [extracted(event, { location, temporalStatus: "scheduled_event" })]);
    assert.ok(result.location.includes(location.startsWith("79") ? locations.locations[1].address : locations.locations[0].address));
    assert.ok(result.sourceLocation);
  }
  assert.throws(() => overlayNycForFreeEvents([event], [extracted(event, { location: "530 Fifth Avenue, Brooklyn" })]), /pairing/);
  assert.throws(() => overlayNycForFreeEvents([event], [extracted(event, { location: "1530 Fifth Avenue, Manhattan" })]), /pairing/);
  const sameCore = { ...event, locations: [{ ...event.locations[0] }, { ...event.locations[0], borough: "Brooklyn", address: "530 Fifth Avenue, Brooklyn, NY" }] };
  assert.throws(() => overlayNycForFreeEvents([sameCore], [extracted(sameCore, { location: "530 Fifth Ave" })]), /Ambiguous/);
});

test("actual scraper identities survive Jazz start-clock and single-venue address corrections", () => {
  const jazz = source({ title: "Jazz Nights in the West Village", slug: "jazz-nights-in-the-west-village", "start-time": "6:30 PM", address: "232 W11th Street, NYC, 10014" });
  const corrected = source({ title: jazz.title, slug: jazz.slug, "start-time": "7:00 PM", address: "232 West 11th Street, Manhattan, New York, NY" });
  const first = overlayNycForFreeEvents([jazz], [extracted(jazz, { temporalStatus: "scheduled_event" })])[0];
  const second = overlayNycForFreeEvents([corrected], [extracted(corrected, { temporalStatus: "scheduled_event" })])[0];
  assert.equal(first.sourceOccurrenceId, second.sourceOccurrenceId);
  const moved = { ...corrected, address: "234 West 11th Street, New York, NY", locations: [{ ...corrected.locations[0], address: "234 West 11th Street, New York, NY" }] };
  assert.equal(overlayNycForFreeEvents([moved], [extracted(moved)])[0].sourceOccurrenceId, first.sourceOccurrenceId);
});

test("explicit same-day source slot ordinals remain distinct and survive clock corrections", () => {
  const first = source({ frequency: "Multiple Dates" }, '<div event-data="occurrences">2026-11-13|10:30|12:00,2026-11-13|12:30|14:00</div>');
  const corrected = source({ frequency: "Multiple Dates" }, '<div event-data="occurrences">2026-11-13|11:00|12:00,2026-11-13|12:30|14:00</div>');
  const originals = overlayNycForFreeEvents([first], [extracted(first)]);
  const updates = overlayNycForFreeEvents([corrected], [extracted(corrected)]);
  assert.equal(new Set(originals.map((event) => event.sourceOccurrenceId)).size, 2);
  assert.deepEqual(updates.map((event) => event.sourceOccurrenceId), originals.map((event) => event.sourceOccurrenceId));
});

test("generic source placeholders never collapse two actual model locations into one single-location identity", () => {
  const event = source({ address: "New York, NY, USA" });
  const templates = ["530 Fifth Avenue, New York, NY", "79 Mercer Street, New York, NY"].map((location) => extracted(event, { location, temporalStatus: "scheduled_event" }));
  const results = overlayNycForFreeEvents([event], templates);
  assert.equal(results.length, 2);
  assert.notEqual(results[0].sourceOccurrenceId, results[1].sourceOccurrenceId);
  assert.ok(results.every((result) => !result.sourceLocation));
});

test("SAVE A TURKEY missing or wrong model pairing recovers both literal stops before the card is staged", async () => {
  const locations = { locations: [
    { address: "25-29 Steinway Street, Queens, NY 11103", borough: "Queens", lat: 40.7671163, lng: -73.9120854 },
    { address: "711 Lydig Avenue, The Bronx, NY 10462", borough: "The Bronx", lat: 40.8546476, lng: -73.8670443 },
  ] };
  const attrs = { title: "SAVE A TURKEY. EAT CHICKEN!", slug: "save-a-turkey-eat-chicken", frequency: "Multiple Dates", "start-date": "November 20, 2026", "end-date": "November 21, 2026", description: "📍 Steinway – Nov 20 | 7 PM 📍 Bronx – Nov 21 | 6 PM" };
  const children = `<div event-data="locations">${escape(JSON.stringify(locations))}</div><div event-data="occurrences">2026-11-20|19:00|22:00,2026-11-21|18:00|22:00</div>`;
  const event = source(attrs, children);
  const state = memoryCache();
  const cache = state.cache();
  let calls = 0;
  const result = await createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card(attrs, children) }), extract: async () => { calls++; return [extracted(event, { location: locations.locations[0].address, ...parseEventTimes("2026-11-21", "18:00", "22:00") })]; } }).scrape(cache);
  assert.equal(calls, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].startTimestamp, Date.parse("2026-11-21T00:00:00Z"));
  assert.equal(result[1].location, locations.locations[1].address);
  assert.equal(cache.stagedKeys.length, 1);
  const invalidCache = state.cache();
  await assert.rejects(createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card({ ...attrs, description: "Independent dates and venues; pairing unspecified." }, children) }), extract: async () => [extracted(event)] }).scrape(invalidCache), /binding/);
  assert.deepEqual(invalidCache.stagedKeys, []);
});

test("ambiguous multi-location date envelopes cannot attach arbitrary trusted pins or stage the whole card", async () => {
  const locations = { locations: [{ address: "530 Fifth Avenue, New York, NY 10036", borough: "Manhattan", lat: 40.7551805, lng: -73.9798802 }, { address: "79 Mercer Street, New York, NY 10012", borough: "Manhattan", lat: 40.7228732, lng: -74.0003615 }] };
  const attrs = { "end-date": "December 24, 2026" };
  const children = `<div event-data="locations">${escape(JSON.stringify(locations))}</div>`;
  const event = source(attrs, children);
  const cache = memoryCache().cache();
  const result = await createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card(attrs, children) }), extract: async () => [extracted(event, { location: locations.locations[0].address, temporalStatus: "scheduled_event" })] }).scrape(cache);
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceLocation, undefined);
  assert.deepEqual(cache.stagedKeys, []);
});

test("temporal exclusions stay excluded and absent evidence never becomes source-authorized", () => {
  const event = source();
  assert.deepEqual(overlayNycForFreeEvents([event], [extracted(event, { temporalStatus: "permanent_attraction" as ScrapedEvent["temporalStatus"] })]), []);
  assert.throws(() => overlayNycForFreeEvents([event], [extracted(event, { temporalEvidence: "" })]), /temporal/);
});

test("richer extraction cache keys include source coordinates, places, recurring rules and occurrences", () => {
  const base = source();
  const key = (event: WebflowEvent) => itemKey("nycforfree", toText(event));
  const changed: WebflowEvent[] = [
    { ...base, endDate: "2026-11-21" }, { ...base, recurringDays: ["Thu"] },
    { ...base, occurrences: [{ date: "2026-11-15", startTime: "11:00", endTime: "17:00" }] },
    { ...base, locations: [{ ...base.locations[0], latitude: 40.74 }] },
    { ...base, locations: [{ ...base.locations[0], name: "Real Source Venue" }] },
    { ...base, description: `${base.description} Full detail source changes.` },
  ];
  for (const event of changed) assert.notEqual(key(event), key(base));
  assert.match(toText(base), /Source locations:.*40\.7417079/);
});

test("scraper detail enrichment exposes full about/map, preserves listing occurrence fields, and stages only after overlays", async () => {
  const event = source({ description: "A truncated pop-up…", "end-date": "November 15, 2026" });
  const pages = {
    [BASE_URL]: card({ description: "A truncated pop-up…", "end-date": "November 15, 2026" }),
    [`${BASE_URL}/${event.slug}`]: detail("423 West 14th Street, New York, NY, USA", "Full source-specific details, not navigation text.", '<div event-data="end-date">November 21, 2026</div>'),
  };
  const state = memoryCache();
  const cache = state.cache();
  let content = "";
  const extract: NycForFreeDependencies["extract"] = async (text) => { content = text; return [extracted(event)]; };
  const result = await createNycForFreeScraper("unused", { fetch: fakeFetch(pages), extract }).scrape(cache);
  assert.match(content, /Full source-specific details/);
  assert.match(content, /Real Source Venue/);
  assert.match(content, /End \(Eastern Time\): 2026-11-21/);
  assert.equal(result[0].sourceLocation?.placeName, "Real Source Venue");
  assert.equal(result[0].endTimestamp, Date.parse("2026-11-22T00:00:00Z"));
  assert.equal(cache.stagedKeys.length, 1);
  assert.equal(state.saved.length, 0);
  await cache.commit();
  assert.equal(state.saved.length, 1);
});

test("detail-only edits are revisited despite an unchanged cached listing; unchanged enriched source avoids model work", async () => {
  const event = source({ description: "Truncated event…" });
  const pages: Record<string, string> = { [BASE_URL]: card({ description: "Truncated event…" }), [`${BASE_URL}/${event.slug}`]: detail(event.address, "First full detail content") };
  const calls: string[] = [];
  const state = memoryCache();
  let extractions = 0;
  const scraper = createNycForFreeScraper("unused", { fetch: fakeFetch(pages, calls), extract: async () => { extractions++; return [extracted(event)]; } });
  const firstCache = state.cache();
  await scraper.scrape(firstCache);
  await firstCache.commit();
  assert.deepEqual(await scraper.scrape(state.cache()), []);
  assert.equal(extractions, 1);
  pages[`${BASE_URL}/${event.slug}`] = detail(event.address, "Corrected full detail content");
  const corrected = await scraper.scrape(state.cache());
  assert.equal(corrected.length, 1);
  assert.equal(extractions, 2);
  assert.equal(calls.filter((url) => url !== BASE_URL).length, 3);
});

test("already explicit metadata skips unnecessary truncated-description details", async () => {
  const event = source({ description: "Truncated…", frequency: "Multiple Dates" }, '<div event-data="occurrences">2026-11-13|11:00|19:00</div>');
  const calls: string[] = [];
  const cache = memoryCache().cache();
  const result = await createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card({ description: "Truncated…", frequency: "Multiple Dates" }, '<div event-data="occurrences">2026-11-13|11:00|19:00</div>') }, calls), extract: async () => [extracted(event)] }).scrape(cache);
  assert.equal(result.length, 1);
  assert.deepEqual(calls, [BASE_URL]);
});

test("detail failures and ambiguous result mapping never stage keys or write cache", async () => {
  const event = source({ description: "Truncated…" });
  const state = memoryCache();
  let modelCalls = 0;
  const cache = state.cache();
  await assert.rejects(createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card({ description: "Truncated…" }), [`${BASE_URL}/${event.slug}`]: 503 }), extract: async () => { modelCalls++; return []; } }).scrape(cache), /fetch failed/);
  assert.equal(modelCalls, 0);
  assert.deepEqual(cache.stagedKeys, []);
  const badMapCache = state.cache();
  await assert.rejects(createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card() }), extract: async () => [extracted(event, { sourceUrl: `${BASE_URL}/not-the-source` })] }).scrape(badMapCache), /Unmatched/);
  assert.deepEqual(badMapCache.stagedKeys, []);
  assert.equal(state.saved.length, 0);
});

test("omitted fresh candidates are retried, while permanent empty outcomes remain unreturned and unstaged", async () => {
  const event = source();
  let attempts = 0;
  const state = memoryCache();
  const cache = state.cache();
  const recovered = await createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card() }), extract: async () => ++attempts === 1 ? [] : [extracted(event)] }).scrape(cache);
  assert.equal(attempts, 2);
  assert.equal(recovered.length, 1);
  assert.equal(cache.stagedKeys.length, 1);
  const permanentCache = state.cache();
  assert.deepEqual(await createNycForFreeScraper("unused", { fetch: fakeFetch({ [BASE_URL]: card({ title: "Permanent attraction admission" }) }), extract: async () => [] }).scrape(permanentCache), []);
  assert.deepEqual(permanentCache.stagedKeys, []);
});

test("necessary detail fetching is bounded to four concurrent requests", async () => {
  const events = Array.from({ length: 9 }, (_, i) => source({ slug: `temporary-pop-up-${i}`, description: "Truncated…" }));
  let active = 0;
  let peak = 0;
  const request: typeof fetch = async (input) => {
    if (String(input) === BASE_URL) return new Response(events.map((event) => card({ slug: event.slug, description: "Truncated…" })).join(""));
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return new Response(detail(events[0].address, "Full source content."));
  };
  const result = await createNycForFreeScraper("unused", { fetch: request, extract: async () => events.map((event) => extracted(event)) }).scrape(memoryCache().cache());
  assert.equal(result.length, 9);
  assert.equal(peak, 4);
});
