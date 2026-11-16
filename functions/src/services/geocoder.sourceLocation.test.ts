import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import type { ScrapedEvent, SourceLocation } from "../scrapers/base.js";
import { resolveEventLocation, segmentQueries } from "./geocoder.js";
import { resolvedLocationViolations, scrapedEventViolations } from "./pipeline/contracts.js";

// Synthetic fixtures for the shapes of source-backed sidewalk, intersection,
// performance, and tree-lighting locations; no live data or provider requests.
function event(overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  const sourceUrl = "https://www.nycforfree.co/events/coffee-truck";
  return {
    title: "Coffee truck", description: "Fixture", category: "free_stuff",
    startTimestamp: 1, endTimestamp: 2, temporalStatus: "scheduled_event",
    temporalEvidence: "Explicit fixture date", sourceName: "nycforfree", sourceUrl,
    location: "Coffee truck, W11th Street and Washington Street, Manhattan",
    sourceLocation: {
      latitude: 40.735, longitude: -74.008,
      address: "W11th Street and Washington Street, Manhattan", sourceUrl,
    },
    ...overrides,
  };
}

function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const reference = (collection: string, id: string) => {
    const key = `${collection}/${id}`;
    return {
      key,
      get: async () => ({ exists: docs.has(key), data: () => docs.get(key) }),
      set: async (data: Record<string, unknown>) => { docs.set(key, data); },
    };
  };
  const db = {
    collection: (name: string) => ({ doc: (id: string) => reference(name, id) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
      get: async (ref: ReturnType<typeof reference>) => ref.get(),
      set: (ref: ReturnType<typeof reference>, data: Record<string, unknown>) => { docs.set(ref.key, data); },
    }),
  } as unknown as Firestore;
  return { db, docs };
}

const noIo = {
  // A trusted source pin must not even obtain a cache document or rate lease.
  db: { collection: () => { throw new Error("Unexpected DB access"); } } as unknown as Firestore,
  fetch: async (): Promise<Response> => { throw new Error("Unexpected network request"); },
  sleep: async (): Promise<void> => { throw new Error("Unexpected provider sleep"); },
};

test("source-backed coffee truck, Jazz, Roebling and tree lightings bypass cache and Nominatim", async () => {
  const fixtures = [
    { title: "Coffee truck", address: "W11th Street and Washington Street, Manhattan", latitude: 40.735, longitude: -74.008 },
    { title: "Jazz", address: "10 Columbus Circle, Manhattan", latitude: 40.768, longitude: -73.983 },
    { title: "Roebling block event", address: "Roebling Street and North 6th Street, Brooklyn", latitude: 40.714, longitude: -73.957 },
    { title: "Madison Square tree lighting", address: "Madison Square Park, Manhattan", latitude: 40.742, longitude: -73.987 },
    { title: "Rockefeller tree lighting", address: "30 Rockefeller Plaza, Manhattan", latitude: 40.759, longitude: -73.979 },
  ];
  for (const [i, fixture] of fixtures.entries()) {
    const sourceUrl = `https://${i % 2 ? "nycforfree.co" : "www.nycforfree.co"}/events/fixture-${i}`;
    const input = event({
      title: fixture.title, sourceUrl,
      location: `${fixture.title}, ${fixture.address.toUpperCase().replace(/ /g, "  ")}`,
      sourceLocation: { ...fixture, placeName: fixture.title, sourceUrl },
    });
    const pin = await resolveEventLocation(input, noIo);
    assert.deepEqual(pin, {
      latitude: fixture.latitude, longitude: fixture.longitude, formattedAddress: fixture.address,
      placeName: fixture.title, query: sourceUrl, provider: "nycforfree", osmId: null, osmType: null,
    });
    assert.deepEqual(resolvedLocationViolations(pin), []);
  }
  // Omitting deps still must not initialize or access a real Firebase app.
  assert.equal((await resolveEventLocation(event()))?.provider, "nycforfree");
});

test("an updated source pin outranks an older provider cache at the same address", async () => {
  const { db, docs } = fakeFirestore();
  let requests = 0;
  const input = event();
  await resolveEventLocation({ ...input, sourceLocation: undefined }, {
    db, now: () => 10_000, sleep: async () => {},
    fetch: async () => {
      requests++;
      return Response.json([{ osm_id: 1, osm_type: "way", lat: "40.7", lon: "-73.97", display_name: "Old provider place", name: "Old place" }]);
    },
  });
  assert.ok([...docs.keys()].some((key) => key.startsWith("geocodingCache/")));
  const before = JSON.stringify([...docs]);
  const pin = await resolveEventLocation(input, {
    db, fetch: async () => { throw new Error("Must not re-geocode source pin"); },
  });
  assert.equal(pin?.provider, "nycforfree");
  assert.equal(pin?.latitude, input.sourceLocation!.latitude);
  assert.equal(requests, 1);
  assert.equal(JSON.stringify([...docs]), before, "source fast path must not mutate cache/rate records");
});

test("malformed, untrusted, mismatched and non-NYC source pins never become valid source pins", async () => {
  const base = event();
  const pin = base.sourceLocation!;
  const badPin = (change: Record<string, unknown>) => event({ sourceLocation: { ...pin, ...change } as SourceLocation });
  const untrusted = (sourceUrl: string) => event({ sourceUrl, sourceLocation: { ...pin, sourceUrl } });
  const cases: Array<[string, ScrapedEvent]> = [
    ["wrong source", event({ sourceName: "other" })],
    ["host suffix spoof", untrusted("https://www.nycforfree.co.evil.invalid/events/coffee-truck")],
    ["unapproved subdomain", untrusted("https://other.nycforfree.co/events/coffee-truck")],
    ["calendar URL", untrusted("https://www.nycforfree.co/events")],
    ["nested path", untrusted("https://www.nycforfree.co/events/coffee-truck/other")],
    ["wrong protocol", untrusted("http://www.nycforfree.co/events/coffee-truck")],
    ["URL credentials", untrusted("https://user@www.nycforfree.co/events/coffee-truck")],
    ["malformed URL", untrusted("not a URL")],
    ["different detail URL", badPin({ sourceUrl: "https://www.nycforfree.co/events/another" })],
    ["mismatched address", badPin({ address: "123 Broadway, Manhattan" })],
    ["substring house number", event({ location: "123 Broadway, Manhattan", sourceLocation: { ...pin, address: "23 Broadway, Manhattan" } })],
    ["empty address", badPin({ address: "" })],
    ["generic address", event({ location: "New York City, NY", sourceLocation: { ...pin, address: "New York City, NY" } })],
    ["comma-free generic address", event({ location: "New York NY", sourceLocation: { ...pin, address: "New York NY" } })],
    ["borough and ZIP", event({ location: "Brooklyn 11211", sourceLocation: { ...pin, address: "Brooklyn 11211" } })],
    ["multiple locations", event({ location: "Multiple locations, " + pin.address })],
    ["vague source address", event({ location: "Various venues", sourceLocation: { ...pin, address: "Various venues" } })],
    ["latitude NaN", badPin({ latitude: NaN })],
    ["longitude infinity", badPin({ longitude: Infinity })],
    ["string latitude", badPin({ latitude: "40.735" })],
    ["outside west", badPin({ longitude: -74.26 })],
    ["outside east", badPin({ longitude: -73.7 })],
    ["outside north", badPin({ latitude: 40.918 })],
    ["outside south", badPin({ latitude: 40.477 })],
    ["invalid name", badPin({ placeName: 42 })],
    ["empty name", badPin({ placeName: " " })],
    ["non-object pin", event({ sourceLocation: "bad" as unknown as SourceLocation })],
    ["partial pin", event({ sourceLocation: {} as SourceLocation })],
    ["bare extracted coordinates", event({ sourceLocation: undefined, latitude: pin.latitude, longitude: pin.longitude })],
  ];
  for (const [label, input] of cases) {
    const { db, docs } = fakeFirestore();
    const result = await resolveEventLocation(input, {
      db, now: () => 10_000, sleep: async () => {}, fetch: async () => Response.json([]),
    });
    assert.equal(result, null, label);
    assert.equal([...docs.keys()].some((key) => key.startsWith("geocodingCache/")), false, label);
  }
});

test("placeholder source addresses are rejected by the geocoder and source pin contract", async () => {
  const base = event();
  for (const address of ["N/A", "unknown", "none", "not specified", "location", "address", "  UnKnOwN  "]) {
    const { db } = fakeFirestore();
    const sourceLocation = { ...base.sourceLocation!, address };
    const result = await resolveEventLocation({ ...base, location: address, sourceLocation }, {
      db, now: () => 10_000, sleep: async () => {}, fetch: async () => Response.json([]),
    });
    assert.equal(result, null, address);
    assert.ok(resolvedLocationViolations({
      latitude: sourceLocation.latitude, longitude: sourceLocation.longitude,
      formattedAddress: address, placeName: null, query: base.sourceUrl,
      provider: "nycforfree", osmId: null, osmType: null,
    }).includes("source address is not specific"), address);
  }
});

test("invalid source provenance falls back to normal accurate Nominatim resolution", async () => {
  const { db } = fakeFirestore();
  let requests = 0;
  const result = await resolveEventLocation(event({ sourceName: "untrusted" }), {
    db, now: () => 10_000, sleep: async () => {},
    fetch: async () => {
      requests++;
      return Response.json([{ osm_id: 9, osm_type: "node", lat: "40.735", lon: "-74.008", display_name: "Washington Street junction", name: "Washington Street junction" }]);
    },
  });
  assert.equal(result?.provider, "nominatim");
  assert.equal(result?.osmId, 9);
  assert.equal(requests, 1);
  assert.deepEqual(resolvedLocationViolations(result), []);
});

test("source pin contract requires specific NYC address, trusted URL and explicit null OSM identity", async () => {
  const pin = (await resolveEventLocation(event(), noIo))!;
  const invalid: Array<Record<string, unknown>> = [
    { provider: "other" }, { latitude: 41 }, { longitude: -75 },
    { formattedAddress: "New York City" }, { formattedAddress: "Various locations" },
    { query: "https://evil.invalid/events/coffee-truck" }, { query: "https://www.nycforfree.co/events" },
    { osmId: 1 }, { osmType: "way" }, { osmId: undefined }, { osmType: undefined },
    { placeName: "" }, { query: "" },
  ];
  for (const change of invalid) assert.ok(resolvedLocationViolations({ ...pin, ...change }).length > 0, JSON.stringify(change));
  const nominatim = { ...pin, provider: "nominatim", query: "Exact venue", osmId: 1, osmType: "way" };
  assert.deepEqual(resolvedLocationViolations(nominatim), []);
  assert.ok(resolvedLocationViolations({ ...nominatim, osmId: null }).includes("osmId is invalid"));
  assert.ok(resolvedLocationViolations({ ...nominatim, osmType: null }).includes("osmType is invalid"));
  assert.ok(resolvedLocationViolations({ ...nominatim, osmId: 1.5 }).includes("osmId is invalid"));
  assert.ok(resolvedLocationViolations({ ...nominatim, osmType: "street" }).includes("osmType is invalid"));
});

test("and intersections and W11th/W 11th variants yield junction queries, not new street centroids", () => {
  const expected = {
    junctionQueries: [
      "West 11th Street & Washington Street, Manhattan, New York, NY",
      "Washington Street & West 11th Street, Manhattan, New York, NY",
    ],
    streetOnlyQuery: null,
  };
  assert.deepEqual(segmentQueries("W11th Street and Washington Street, Manhattan"), expected);
  assert.deepEqual(segmentQueries("W 11th Street and Washington Street, Manhattan"), expected);
  assert.deepEqual(segmentQueries("Roebling Street and N 6th Street, Brooklyn"), {
    junctionQueries: [
      "Roebling Street & North 6th Street, Brooklyn, New York, NY",
      "North 6th Street & Roebling Street, Brooklyn, New York, NY",
    ], streetOnlyQuery: null,
  });
  assert.deepEqual(segmentQueries("Jazz and Friends, Manhattan"), { junctionQueries: [], streetOnlyQuery: null });
});

test("sourceOccurrenceId contract allows absent or nonempty string identifiers only", () => {
  assert.deepEqual(scrapedEventViolations(event()), []);
  assert.deepEqual(scrapedEventViolations({ ...event(), sourceOccurrenceId: "source-session-1" }), []);
  for (const sourceOccurrenceId of [null, 1, "", " ", {}, []]) {
    assert.ok(scrapedEventViolations({ ...event(), sourceOccurrenceId }).includes("sourceOccurrenceId is invalid"));
  }
});

test("numbered W11th addresses normalize to the same precise fallback query as W 11th", async () => {
  const queries: string[] = [];
  for (const street of ["W11th Street", "W 11th Street"]) {
    const { db } = fakeFirestore();
    await resolveEventLocation(event({ sourceLocation: undefined, location: `123 ${street}, Manhattan` }), {
      db, now: () => 10_000, sleep: async () => {},
      fetch: async (url) => {
        queries.push(new URL(String(url)).searchParams.get("q")!);
        return Response.json([{ osm_id: 1, osm_type: "way", lat: "40.735", lon: "-74.008", display_name: "123 West 11th Street, Manhattan", address: { house_number: "123" } }]);
      },
    });
  }
  assert.deepEqual(queries, ["123 West 11th Street, Manhattan, New York, NY", "123 West 11th Street, Manhattan, New York, NY"]);
});
