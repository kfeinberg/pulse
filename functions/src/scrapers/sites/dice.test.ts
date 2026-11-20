import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import type { ScrapedEvent } from "../base.js";
import { resolveEventLocation } from "../../services/geocoder.js";
import { parseEventTimes } from "../../services/parser.js";
import { resolvedLocationViolations } from "../../services/pipeline/contracts.js";
import { diceSourcePin, diceVenueLabel, extractJsonLd, formatDiceAddress, matchDiceDetail, overlayDiceDetail, type DiceDetail } from "./dice.js";

// Shapes copied from live Dice event pages (Nov 2026): the address is a
// schema.org PostalAddress object and the venue carries GeoCoordinates.
const seventhHeaven: DiceDetail = {
  url: "https://dice.fm/event/6ab5dacc3fd3b200011434df",
  event: {
    "@type": "ScreeningEvent", name: "Jojo's Bizarre Adventure: Steel Ball Run // Ep. 10",
    startDate: "2026-11-20T17:00:00-05:00", endDate: "2026-11-20T19:00:00-05:00",
    location: {
      name: "Seventh Heaven Bar & Karaoke",
      address: { streetAddress: "4 Irving Avenue, Brooklyn, New York 11237, United States", addressLocality: "Brooklyn" } as never,
      geo: { latitude: 40.705498, longitude: -73.925999 },
    },
  },
};
const ames: DiceDetail = {
  url: "https://dice.fm/event/6afba943717c030001811bf3",
  event: {
    "@type": "Event", name: "Ames Jewelry Open Studio - Friday 11/20",
    location: {
      name: "Ames Jewelry",
      // Dice's separate locality is wrong here; the street address is right.
      address: { streetAddress: "199 Cook Street Suite 203, Brooklyn, New York 11206, United States", addressLocality: "Long Island City" } as never,
      geo: { latitude: 40.703321, longitude: -73.934922 },
    },
  },
};

function parsed(overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    title: "Jojo's Bizarre Adventure: Steel Ball Run // Ep. 10", description: "Screening",
    ...parseEventTimes("2026-11-20", "17:00", "19:00"), location: "Seventh Heaven Bar & Karaoke", category: "happening",
    sourceUrl: seventhHeaven.url, sourceName: "dice", temporalStatus: "scheduled_event", temporalEvidence: "November 20 at 5pm",
    ...overrides,
  };
}

const noIo = {
  db: { collection: () => { throw new Error("Unexpected DB access"); } } as unknown as Firestore,
  fetch: async (): Promise<Response> => { throw new Error("Unexpected network request"); },
  sleep: async (): Promise<void> => { throw new Error("Unexpected provider sleep"); },
};

test("PostalAddress objects become readable street addresses instead of [object Object]", () => {
  assert.equal(formatDiceAddress(seventhHeaven.event.location!.address), "4 Irving Avenue, Brooklyn, New York 11237");
  assert.equal(formatDiceAddress(ames.event.location!.address), "199 Cook Street Suite 203, Brooklyn, New York 11206");
  assert.equal(formatDiceAddress({ streetAddress: "1 Main St", addressLocality: "Brooklyn", addressRegion: "NY", postalCode: "11201" }), "1 Main St, Brooklyn, NY, 11201");
  assert.equal(formatDiceAddress("10 Main St, Brooklyn, NY, USA"), "10 Main St, Brooklyn, NY");
  assert.equal(formatDiceAddress(undefined), "");
  assert.equal(diceVenueLabel(seventhHeaven.event), "Seventh Heaven Bar & Karaoke, 4 Irving Avenue, Brooklyn, New York 11237");
  assert.doesNotMatch(diceVenueLabel(ames.event), /object/);
});

test("JSON-LD event nodes are found by any *Event type, in arrays and @graph blocks", () => {
  const page = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
  assert.equal(extractJsonLd(page({ "@type": "Organization" }) + page(seventhHeaven.event))?.name, seventhHeaven.event.name);
  assert.equal(extractJsonLd(page([{ "@type": "WebSite" }, { "@type": ["ComedyEvent"], name: "Stand-up" }]))?.name, "Stand-up");
  assert.equal(extractJsonLd(page({ "@graph": [{ "@type": "MusicEvent", name: "Show" }] }))?.name, "Show");
  assert.equal(extractJsonLd(page({ "@type": "WebSite" })), null);
});

test("the overlay attaches the venue's own pin and address to the event it came from", async () => {
  const event = parsed();
  overlayDiceDetail(event, seventhHeaven);
  assert.equal(event.location, "Seventh Heaven Bar & Karaoke, 4 Irving Avenue, Brooklyn, New York 11237");
  assert.deepEqual(event.sourceLocation, {
    latitude: 40.705498, longitude: -73.925999, address: "4 Irving Avenue, Brooklyn, New York 11237",
    placeName: "Seventh Heaven Bar & Karaoke", sourceUrl: seventhHeaven.url,
  });
  const pin = await resolveEventLocation(event, noIo);
  assert.equal(pin?.provider, "dice");
  assert.equal(pin?.latitude, 40.705498);
  assert.equal(pin?.query, seventhHeaven.url);
  assert.deepEqual(resolvedLocationViolations(pin), []);
});

test("Dice pins outside NYC, at the city centroid, or on an untrusted URL are never trusted", () => {
  const withGeo = (latitude: number, longitude: number): DiceDetail => ({ ...seventhHeaven, event: { ...seventhHeaven.event, location: { ...seventhHeaven.event.location!, geo: { latitude, longitude } } } });
  assert.equal(diceSourcePin(withGeo(40.7357, -74.1724)), undefined); // Newark
  assert.equal(diceSourcePin(withGeo(40.7127753, -74.0059728)), undefined);
  assert.equal(diceSourcePin({ ...seventhHeaven, url: "https://dice.fm.evil.example/event/abc" }), undefined);
  assert.equal(diceSourcePin({ ...seventhHeaven, event: { ...seventhHeaven.event, location: { name: "Secret location", geo: { latitude: 40.7, longitude: -73.95 } } } }), undefined);
  // A Dice-style pin cannot be passed off under another source's name.
  const event = parsed();
  overlayDiceDetail(event, seventhHeaven);
  assert.ok(resolvedLocationViolations({ latitude: 40.7, longitude: -73.9, formattedAddress: "4 Irving Avenue, Brooklyn", placeName: null, query: "https://www.nycforfree.co/events/x", provider: "dice", osmId: null, osmType: null }).includes("source query is not a trusted event URL"));
});

test("an untrusted source name cannot use a Dice pin", async () => {
  const event = parsed({ sourceName: "theskint" });
  overlayDiceDetail(event, seventhHeaven);
  const docs = new Map<string, unknown>();
  const ref = (key: string) => ({ key, get: async () => ({ exists: docs.has(key), data: () => docs.get(key) }), set: async (data: unknown) => { docs.set(key, data); } });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
      get: async (r: ReturnType<typeof ref>) => r.get(),
      set: (r: ReturnType<typeof ref>, data: unknown) => { docs.set(r.key, data); },
    }),
  } as unknown as Firestore;
  const result = await resolveEventLocation(event, { db, now: () => 0, sleep: async () => {}, fetch: async () => Response.json([]) });
  assert.equal(result, null);
});

test("events map back to their Dice item by exact URL first, and an ambiguous title maps to none", () => {
  const twin: DiceDetail = { url: "https://dice.fm/event/6ab5dacc3fd3b200011434e0", event: { ...seventhHeaven.event } };
  assert.equal(matchDiceDetail(parsed({ sourceUrl: twin.url }), [seventhHeaven, twin]), twin);
  assert.equal(matchDiceDetail(parsed({ sourceUrl: "https://dice.fm/browse/new_york" }), [seventhHeaven, twin]), undefined);
  assert.equal(matchDiceDetail(parsed({ sourceUrl: "https://dice.fm/browse/new_york" }), [seventhHeaven, ames]), seventhHeaven);
});
