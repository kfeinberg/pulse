import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { upsertEvent } from "./firestore.js";
import type { ScrapedEvent } from "../scrapers/base.js";
import type { ResolvedLocation } from "./geocoder.js";

// A legacy row can already contain the URL of a different, falsely merged
// event. It must not acquire that event's new authoritative schedule/identity.
test("a legacy conflated source URL cannot let Vessel overwrite Shine Bright's schedule", async () => {
  const start = Date.parse("2026-11-16T13:00:00Z");
  const end = Date.parse("2027-01-08T03:45:00Z");
  const vesselUrl = "https://www.nycforfree.co/events/vessel-lighting-ceremony";
  const shineUrl = "https://www.nycforfree.co/events/shine-bright-at-hudson-yards";
  const docs = new Map<string, Record<string, unknown>>([["shine", {
    title: "Shine Bright at Hudson Yards 2026", location: "20 Hudson Yards, Manhattan",
    startTime: Timestamp.fromMillis(start), endTime: Timestamp.fromMillis(end),
    temporalStatus: "limited_run", temporalEvidence: "Through January 7", sourceUrl: shineUrl,
    sourceUrls: [shineUrl, vesselUrl], thumbsUp: 8,
  }]]);
  const snap = (id: string) => ({ id, exists: docs.has(id), data: () => docs.get(id), ref: ref(id) });
  const ref = (id: string) => ({
    id, get: async () => snap(id), update: async (patch: Record<string, unknown>) => { docs.set(id, { ...docs.get(id), ...patch }); },
    create: async (data: Record<string, unknown>) => { assert.ok(!docs.has(id)); docs.set(id, data); },
  });
  const query = (filters: Array<(data: Record<string, unknown>) => boolean> = []) => ({
    doc: ref,
    where: (key: string, op: string, value: unknown) => query([...filters, (data) => {
      const scalar = (v: unknown) => v instanceof Timestamp ? v.toMillis() : v;
      const a = scalar(data[key]) as string | number;
      const b = scalar(value) as string | number;
      if (op === "==") return a === b;
      if (op === ">=") return a >= b;
      if (op === "<") return a < b;
      throw Error(`Unexpected operation ${op}`);
    }]),
    get: async () => { const rows = [...docs.keys()].filter((id) => filters.every((f) => f(docs.get(id)!))).map(snap); return { docs: rows, empty: !rows.length }; },
  });
  const db = { collection: () => query() } as unknown as Firestore;
  const event: ScrapedEvent = {
    title: "Vessel Lighting Ceremony", location: "20 Hudson Yards, Manhattan", description: "One-night ceremony",
    startTimestamp: Date.parse("2026-11-16T22:00:00Z"), endTimestamp: Date.parse("2026-11-16T23:00:00Z"),
    sourceUrl: vesselUrl, sourceName: "nycforfree", category: "happening", temporalStatus: "scheduled_event",
    temporalEvidence: "November 16 at 5pm", sourceOccurrenceId: "vessel-lighting-ceremony|2026-11-16|17:00|20 hudson yards",
  };
  const geo: ResolvedLocation = { latitude: 40.754, longitude: -74.002, formattedAddress: event.location,
    placeName: null, query: vesselUrl, provider: "nycforfree", osmId: null, osmType: null };
  const result = await upsertEvent(event, geo, "unused", "vessel", { db, fuzzyDuplicate: async (_event, _start, candidates) => {
    assert.equal(candidates.length, 0, "conflated legacy event must not be offered for another fuzzy merge");
    return null;
  } });
  assert.deepEqual(result, { kind: "added", eventId: "vessel" });
  assert.equal(docs.size, 2);
  assert.equal((docs.get("shine")!.startTime as Timestamp).toMillis(), start);
  assert.equal((docs.get("shine")!.endTime as Timestamp).toMillis(), end);
  assert.equal(docs.get("shine")!.temporalStatus, "limited_run");
  assert.equal(docs.get("shine")!.sourceOccurrenceId, undefined);
  assert.equal(docs.get("shine")!.thumbsUp, 8);
});
