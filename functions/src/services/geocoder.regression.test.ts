import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import type { ScrapedEvent } from "../scrapers/base.js";
import { LocationLookupError, reserveNominatimRequest, resolveEventLocation } from "./geocoder.js";

function fakeFirestore(afterTransaction?: (count: number) => void) {
  const docs = new Map<string, Record<string, unknown>>();
  let transactions = 0;
  const reference = (collection: string, id: string) => {
    const key = `${collection}/${id}`;
    return { key, get: async () => ({ exists: docs.has(key), data: () => docs.get(key) }), set: async (data: Record<string, unknown>) => { docs.set(key, data); } };
  };
  const db = {
    collection: (name: string) => ({ doc: (id: string) => reference(name, id) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const result = await fn({
        get: async (ref: ReturnType<typeof reference>) => ref.get(),
        set: (ref: ReturnType<typeof reference>, data: Record<string, unknown>) => { docs.set(ref.key, data); },
      });
      afterTransaction?.(++transactions);
      return result;
    },
  } as unknown as Firestore;
  return { docs, db };
}
const EVENT: ScrapedEvent = {
  title: "Fixture Concert", description: "Fixture", location: "Venue, 123 Broadway, Manhattan", category: "concerts",
  sourceName: "test", sourceUrl: "https://example.invalid/fixture", startTimestamp: 1, endTimestamp: 2,
  temporalStatus: "scheduled_event", temporalEvidence: "Explicit date",
};

test("shared request budget survives fresh geocoder clients and counts fallback requests", async () => {
  const { db } = fakeFirestore();
  assert.equal(await reserveNominatimRequest(db, 10_000), 10_000);
  assert.equal(await reserveNominatimRequest(db, 10_000), 11_100);
  assert.equal(await reserveNominatimRequest(db, 10_001), 12_200);
});

test("a throttled lookup retries instead of producing a durable missing pin", async () => {
  const { docs, db } = fakeFirestore();
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(resolveEventLocation(EVENT, {
    db, now: () => 10_000, sleep: async (ms) => { waits.push(ms); },
    fetch: async () => { calls++; return new Response("throttled", { status: 429 }); },
  }), LocationLookupError);
  assert.equal(calls, 1);
  assert.ok(waits.includes(5000));
  assert.equal([...docs.keys()].some((key) => key.startsWith("geocodingCache/")), false);
});

test("a successful lookup is cached and a fresh client performs no provider request", async () => {
  const { db } = fakeFirestore();
  let calls = 0;
  const deps = {
    db, now: () => 10_000, sleep: async () => {},
    fetch: async () => { calls++; return Response.json([{ osm_id: 1, osm_type: "way", lat: "40.7", lon: "-73.97", display_name: "123 Broadway, Manhattan", name: "Venue", type: "building", address: { house_number: "123" } }]); },
  };
  const first = await resolveEventLocation(EVENT, deps);
  const second = await resolveEventLocation(EVENT, { ...deps });
  assert.equal(first!.latitude, 40.7);
  assert.equal(second!.latitude, first!.latitude);
  assert.equal(calls, 1);
});

const RESULT = { osm_id: 1, osm_type: "way", lat: "40.7", lon: "-73.97", display_name: "123 Broadway, Manhattan", name: "Venue", type: "building", address: { house_number: "123" } };

test("slow reservations still space actual fallback requests and fresh-client handoff", async () => {
  let clock = 10_000;
  const { db } = fakeFirestore((count) => { if (count === 1) clock += 2000; });
  const sentAt: number[] = [];
  const deps = {
    db, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    fetch: async () => {
      sentAt.push(clock);
      clock += 50;
      return Response.json(sentAt.length === 1 ? [] : [RESULT]);
    },
  };
  await resolveEventLocation(EVENT, deps);
  await resolveEventLocation({ ...EVENT, location: "Other Venue, 124 Broadway, Manhattan" }, { ...deps });
  assert.deepEqual(sentAt, [12_000, 13_150, 14_300]);
  assert.ok(sentAt.slice(1).every((time, i) => time - sentAt[i] >= 1100));
});

test("transport and response-body failures also finish their actual-request cooldown", async () => {
  let clock = 10_000;
  const { db } = fakeFirestore();
  const sentAt: number[] = [];
  await resolveEventLocation(EVENT, {
    db, now: () => clock, sleep: async (ms) => { clock += ms; },
    fetch: async () => {
      sentAt.push(clock);
      clock += 50;
      if (sentAt.length === 1) throw new Error("fake network failure");
      if (sentAt.length === 2) {
        const response = Response.json([]);
        response.json = async () => { clock += 500; throw new Error("fake body failure"); };
        return response;
      }
      return Response.json([RESULT]);
    },
  });
  assert.equal(sentAt.length, 3);
  assert.ok(sentAt.slice(1).every((time, i) => time - sentAt[i] >= 1100));
});
