import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { parseEventTimes } from "../../services/parser.js";
import { upsertEvent } from "../../services/firestore.js";
import type { ScrapedEvent } from "../base.js";
import type { ResolvedLocation } from "../../services/geocoder.js";
import { overlayNycForFreeEvents, parseWebflowEvents } from "./nycforfree.js";

const source = parseWebflowEvents(`<div class="w-dyn-item" title="Roebling Rink Opening Day Celebration" slug="roebling-rink-opening-day-celebration" start-date="November 14, 2026" end-date="November 14, 2026" start-time="10:30 AM" end-time="2:00 PM" address="Emily Warren Roebling Plaza, Brooklyn Bridge Park, Brooklyn, NY" frequency="One-time" borough="Brooklyn" description="FREE sessions: 10:30 AM to 12:00 PM and 12:30 PM to 2:00 PM" lat="40.7044979" long="-73.9938027"></div>`)[0];
const template = (start: string, end: string): ScrapedEvent => ({
  title: source.title, description: source.description,
  ...parseEventTimes("2026-11-14", start, end), location: source.address,
  category: "happening", sourceName: "nycforfree",
  sourceUrl: "https://www.nycforfree.co/events/roebling-rink-opening-day-celebration",
  temporalStatus: "scheduled_event", temporalEvidence: "Free opening-day skating sessions November 14",
});
const early = template("10:30", "12:00");
const late = template("12:30", "14:00");

test("Roebling inferred session IDs do not follow nondeterministic extraction array order", () => {
  const forward = overlayNycForFreeEvents([source], [early, late]);
  const reverse = overlayNycForFreeEvents([source], [late, early]);
  for (const original of forward) {
    assert.equal(reverse.find((event) => event.startTimestamp === original.startTimestamp)!.sourceOccurrenceId, original.sourceOccurrenceId);
  }
  assert.equal(new Set(forward.map((event) => event.sourceOccurrenceId)).size, 2);
  assert.equal(overlayNycForFreeEvents([source], [early, early, late, late]).length, 2);
});

test("reversed Roebling extraction cannot move existing engagement to another session", async () => {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (id: string) => ({
    id, get: async () => snap(id),
    create: async (data: Record<string, unknown>) => { assert.ok(!docs.has(id)); docs.set(id, data); },
    update: async (patch: Record<string, unknown>) => { docs.set(id, { ...docs.get(id), ...patch }); },
  });
  const snap = (id: string) => ({ id, exists: docs.has(id), data: () => docs.get(id), ref: ref(id) });
  const query = (filters: Array<(data: Record<string, unknown>) => boolean> = []) => ({
    doc: ref,
    where: (key: string, op: string, value: unknown) => query([...filters, (data) => {
      const scalar = (v: unknown) => v instanceof Timestamp ? v.toMillis() : v;
      const a = scalar(data[key]) as number | string; const b = scalar(value) as number | string;
      if (op === "==") return a === b;
      if (op === ">=") return a >= b;
      if (op === "<") return a < b;
      throw Error(`Unexpected operation ${op}`);
    }]),
    get: async () => { const rows = [...docs.keys()].filter((id) => filters.every((f) => f(docs.get(id)!))).map(snap); return { docs: rows, empty: !rows.length }; },
  });
  const db = { collection: () => query() } as unknown as Firestore;
  const geo: ResolvedLocation = { latitude: 40.7044979, longitude: -73.9938027, formattedAddress: source.address,
    placeName: "Roebling Rink", provider: "nycforfree", query: early.sourceUrl, osmId: null, osmType: null };
  const first = overlayNycForFreeEvents([source], [early, late]);
  const deps = { db, fuzzyDuplicate: async () => null };
  await upsertEvent(first[0], geo, "unused", "early", deps);
  await upsertEvent(first[1], geo, "unused", "late", deps);
  docs.get("early")!.thumbsUp = 7;
  for (const [index, event] of overlayNycForFreeEvents([source], [late, early]).entries()) {
    assert.equal((await upsertEvent(event, geo, "unused", `replay-${index}`, deps)).kind, "merged");
  }
  assert.equal(docs.size, 2);
  assert.equal((docs.get("early")!.startTime as Timestamp).toMillis(), early.startTimestamp);
  assert.equal((docs.get("late")!.startTime as Timestamp).toMillis(), late.startTimestamp);
  assert.equal(docs.get("early")!.thumbsUp, 7);
  assert.equal(docs.get("late")!.thumbsUp, undefined);
});
