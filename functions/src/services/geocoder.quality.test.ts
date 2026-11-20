import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import type { ScrapedEvent } from "../scrapers/base.js";
import { cleanLocation, placeNameVariants, resolveEventLocation } from "./geocoder.js";
import { resolvedLocationViolations } from "./pipeline/contracts.js";

function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const reference = (collection: string, id: string) => {
    const key = `${collection}/${id}`;
    return { key, get: async () => ({ exists: docs.has(key), data: () => docs.get(key) }), set: async (data: Record<string, unknown>) => { docs.set(key, data); } };
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

function event(location: string, overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    title: "Fixture", description: "Fixture", location, category: "clubs", sourceName: "posh",
    sourceUrl: "https://posh.vip/e/fixture", startTimestamp: 1, endTimestamp: 2,
    temporalStatus: "scheduled_event", temporalEvidence: "Explicit date", ...overrides,
  };
}

// Records every query and answers from a table (unknown queries find nothing).
async function queriesFor(location: string, answers: Record<string, unknown[]> = {}, overrides: Partial<ScrapedEvent> = {}) {
  const { db } = fakeFirestore();
  const queries: string[] = [];
  const result = await resolveEventLocation(event(location, overrides), {
    db, now: () => 10_000, sleep: async () => {},
    fetch: async (url) => {
      const q = new URL(String(url)).searchParams.get("q")!;
      queries.push(q);
      return Response.json(answers[q] ?? []);
    },
  });
  return { queries, result };
}

const HIT = (name: string, houseNumber?: string) => ({
  osm_id: 7, osm_type: "node", lat: "40.75", lon: "-73.99", name, display_name: `${name}, Manhattan`,
  ...(houseNumber ? { address: { house_number: houseNumber } } : {}),
});

test("location cleanup drops units, countries, duplicates and stray clock times but keeps the place", () => {
  assert.equal(cleanLocation("Club 51, 629 W 51st St, New York, NY 10019, USA"), "Club 51, 629 West 51st St, New York, NY 10019");
  assert.equal(cleanLocation("The NY Archive, Suite 401 (Fourth Floor), 150 W 25th St, New York, NY 10001, USA"), "The NY Archive, 150 West 25th St, New York, NY 10001");
  assert.equal(cleanLocation("City Council Hearing Room 3, 250 Broadway, 8th Floor, Manhattan, NY"), "250 Broadway, Manhattan, NY");
  assert.equal(cleanLocation("00:00, 21-38 44th Rd, Long Island City, NY 11101, USA"), "21-38 44th Rd, Long Island City, NY 11101");
  assert.equal(cleanLocation("12 Park St, 12 Park St, Brooklyn, NY 11206, USA"), "12 Park St, Brooklyn, NY 11206");
  assert.equal(cleanLocation("Ames Jewelry, 199 Cook Street Suite 203, Brooklyn, New York 11206"), "Ames Jewelry, 199 Cook Street, Brooklyn, New York 11206");
  // Venue names that merely contain a unit word are not units.
  assert.equal(cleanLocation("Record Room, 47-09 Center Blvd, Long Island City, NY 11101"), "Record Room, 47-09 Center Blvd, Long Island City, NY 11101");
});

test("an address that already names its state is not given a second city, and is tried before the bare venue name", async () => {
  const { queries } = await queriesFor("Club 51, 629 W 51st St, New York, NY 10019, USA");
  assert.deepEqual(queries.slice(0, 3), [
    "Club 51, 629 West 51st St, New York, NY 10019",
    "629 West 51st St, New York, NY 10019",
    "Club 51, New York, NY",
  ]);
  assert.ok(queries.every((q) => !/USA|NY 10019, New York, NY/.test(q)));
  const duplicated = await queriesFor("258 Johnson Ave, Brooklyn NY 11206, 258 Johnson Ave, Brooklyn, NY 11206, USA");
  assert.equal(duplicated.queries[0], "258 Johnson Ave, Brooklyn NY 11206");
});

test("the cleaned street address resolves a Posh venue that used to be skipped", async () => {
  const { result } = await queriesFor("Saint James Libations, 269 Stanhope St, Brooklyn, NY 11237, USA", {
    "269 Stanhope St, Brooklyn, NY 11237": [HIT("", "269")],
  });
  assert.equal(result?.provider, "nominatim");
  assert.equal(result?.query, "269 Stanhope St, Brooklyn, NY 11237");
});

test("bare place-name variants are specific, and one-word or generic remainders are not looked up alone", () => {
  assert.deepEqual(placeNameVariants("The Frick Collection"), ["Frick Collection"]);
  assert.deepEqual(placeNameVariants("Lincoln Center's David Rubenstein Atrium"), ["Lincoln Center's David Rubenstein Atrium", "David Rubenstein Atrium"]);
  assert.deepEqual(placeNameVariants("Hudson River Park's Pier 84"), ["Hudson River Park's Pier 84", "Pier 84"]);
  assert.deepEqual(placeNameVariants("Rudy's Bar & Grill"), ["Rudy's Bar & Grill"]);
  assert.deepEqual(placeNameVariants("Sleepwalk"), []);
  assert.deepEqual(placeNameVariants("Brooklyn"), []);
});

test("a bare-name lookup only accepts a result that carries the place's name", async () => {
  const wrong = await queriesFor("The Frick Collection, Upper East Side, Manhattan", {
    "Frick Collection": [{ ...HIT("Collection Bar"), osm_id: 9 }],
  }, { sourceName: "theskint", sourceUrl: "https://www.theskint.com/" });
  assert.equal(wrong.result, null);
  assert.ok(wrong.queries.includes("Frick Collection"));
  const right = await queriesFor("The Frick Collection, Upper East Side, Manhattan", {
    "Frick Collection": [HIT("Frick Collection")],
  }, { sourceName: "theskint", sourceUrl: "https://www.theskint.com/" });
  assert.equal(right.result?.placeName, "Frick Collection");
  assert.equal(right.result?.query, "Frick Collection");
  assert.deepEqual(resolvedLocationViolations(right.result), []);
});

test("locations with a street address never fall back to a bare-name lookup", async () => {
  const { queries } = await queriesFor("Village East by Angelika, 181-189 2nd Ave, Manhattan");
  assert.ok(!queries.includes("Village East by Angelika"));
});

test("New Jersey and other non-NYC places are kept off the NYC map", async () => {
  const { isOutsideNyc, isWestOfHudson, isWithinNyc } = await import("./geocoder.js");
  for (const location of [
    "Loew's Jersey Theatre, 54 Journal Square, Jersey City, NJ 07306",
    "Art House Productions, 345 Marin Boulevard, Jersey City, NJ 07302",
    "Basilica Hudson, 110 South Front Street, Hudson, NY 12534",
    "Stop and Shop – Cross County, 111 Vredenburgh Ave, Yonkers, NY 10704",
    "199 Cook Street, Hoboken, New Jersey",
  ]) assert.equal(isOutsideNyc(location), true, location);
  for (const location of [
    "Market Hotel, 1142 Myrtle Ave, Brooklyn, NY 11221", "21-38 44th Rd, Long Island City, NY 11101",
    "Beach 32nd St, Queens, NY 11691", "10 Columbus Circle, Manhattan", "11201 Broadway Studio, Manhattan",
  ]) assert.equal(isOutsideNyc(location), false, location);
  // West of the Hudson inside the rectangular viewbox: Hoboken, Jersey City, Newark, Fort Lee, Bayonne.
  for (const [lat, lon] of [[40.744, -74.0324], [40.7163, -74.033], [40.7357, -74.1724], [40.8509, -73.9701], [40.6687, -74.1143]]) {
    assert.equal(isWestOfHudson(lat, lon), true, `${lat},${lon}`);
    assert.equal(isWithinNyc(lat, lon), false, `${lat},${lon}`);
  }
  // Riverside and Hudson River Park piers, the Battery, Governors Island, the Statue, Inwood, St. George.
  for (const [lat, lon] of [[40.7637, -73.9997], [40.7466, -74.01], [40.7033, -74.017], [40.6895, -74.0168], [40.6892, -74.0445], [40.8724, -73.9256], [40.6437, -74.0736], [40.8115, -73.9637]]) {
    assert.equal(isWithinNyc(lat, lon), true, `${lat},${lon}`);
  }
  const jersey = await queriesFor("Loew's Jersey Theatre, 54 Journal Square, Jersey City, NJ 07306");
  assert.equal(jersey.result, null);
  assert.deepEqual(jersey.queries, []);
  // A New Jersey result for an ambiguous NYC-looking query is discarded.
  const across = await queriesFor("Pier 13, 13 River Road, New York, NY", {
    "Pier 13, 13 River Road, New York, NY": [{ ...HIT("Pier 13", "13"), lat: "40.7440", lon: "-74.0240", address: { house_number: "13", state: "New Jersey" } }],
  });
  assert.equal(across.result, null);
});

test("court and park abbreviations are not mistaken for other states", async () => {
  const { isOutsideNyc } = await import("./geocoder.js");
  assert.equal(isOutsideNyc("Bay Ridge Ct, Ct 3, Brooklyn"), false);
  assert.equal(isOutsideNyc("Marine Park, Pa, Brooklyn"), false);
  assert.equal(isOutsideNyc("Main Hall, 5 Market St, Paterson, NJ"), true);
});
