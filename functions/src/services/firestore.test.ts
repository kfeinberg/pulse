import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { ScrapedEvent } from "../scrapers/base.js";
import type { ResolvedLocation } from "./geocoder.js";
import { nycDayBounds, parseDuplicateResponse, upsertEvent } from "./firestore.js";

const PIN: ResolvedLocation = { latitude: 40.7, longitude: -73.97, formattedAddress: "Fixture venue", placeName: "Venue", query: "Venue NYC", provider: "nominatim", osmId: 1, osmType: "way" };
function event(date: string): ScrapedEvent {
  const startTimestamp = Date.parse(`${date}T22:00:00Z`);
  return { title: "Recurring Concert", description: "Fixture", location: "Fixture Venue", category: "concerts", sourceName: "ohmyrockness", sourceUrl: "https://example.com/concert", startTimestamp, endTimestamp: startTimestamp + 3600_000, temporalStatus: "scheduled_event", temporalEvidence: `${date} at 6pm` };
}
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const snapshot = (id: string) => ({ id, exists: docs.has(id), data: () => docs.get(id), ref: reference(id) });
  const reference = (id: string) => ({
    id, get: async () => snapshot(id),
    update: async (data: Record<string, unknown>) => { docs.set(id, { ...docs.get(id), ...data }); },
    create: async (data: Record<string, unknown>) => { if (docs.has(id)) throw Object.assign(new Error("exists"), { code: 6 }); docs.set(id, data); },
  });
  const query = (predicates: Array<(data: Record<string, unknown>) => boolean> = []) => ({
    doc: reference,
    where: (key: string, op: string, value: unknown) => query([...predicates, (data) => {
      const scalar = (v: unknown) => v instanceof Timestamp ? v.toMillis() : v;
      const a = scalar(data[key]) as number | string;
      const b = scalar(value) as number | string;
      if (op === "==") return a === b;
      if (op === ">=") return a >= b;
      if (op === "<=") return a <= b;
      if (op === "<") return a < b;
      throw new Error(`unexpected operator ${op}`);
    }]),
    get: async () => {
      const rows = [...docs.keys()].filter((id) => predicates.every((predicate) => predicate(docs.get(id)!))).map(snapshot);
      return { docs: rows, empty: rows.length === 0 };
    },
  });
  return { docs, db: { collection: () => query() } as unknown as Firestore };
}

test("recurring concerts with the same title/place on distinct days are not merged", async () => {
  const { docs, db } = fakeFirestore();
  for (const [id, date] of [["a", "2026-10-20"], ["b", "2026-10-21"]]) {
    assert.equal((await upsertEvent(event(date), PIN, "unused", id, { db, fuzzyDuplicate: async () => null })).kind, "added");
  }
  assert.equal(docs.size, 2);
});

test("crash retry reuses a deterministic insertion id without rerunning fuzzy matching", async () => {
  const { docs, db } = fakeFirestore();
  const deps = { db, fuzzyDuplicate: async () => { throw new Error("must not match an existing insertion"); } };
  assert.deepEqual(await upsertEvent(event("2026-10-20"), PIN, "unused", "id", deps), { kind: "added", eventId: "id" });
  assert.deepEqual(await upsertEvent(event("2026-10-20"), PIN, "unused", "id", deps), { kind: "added", eventId: "id" });
  assert.equal(docs.size, 1);
});

test("exact merge preserves curated category and merges URLs without an extra event", async () => {
  const { docs, db } = fakeFirestore();
  const e = event("2026-10-20");
  await upsertEvent(e, PIN, "unused", "a", { db });
  docs.get("a")!.category = "happening";
  const result = await upsertEvent({ ...e, sourceUrl: "https://example.org/other" }, PIN, "unused", "b", { db });
  assert.deepEqual(result, { kind: "merged", eventId: "a", match: "title+time" });
  assert.equal(docs.get("a")!.category, "happening");
  assert.deepEqual(docs.get("a")!.sourceUrls, ["https://example.org/other", "https://example.com/concert"]);
  assert.equal(docs.size, 1);
});

test("fuzzy provider failure propagates without adding a potential duplicate", async () => {
  const { docs, db } = fakeFirestore();
  await upsertEvent(event("2026-10-20"), PIN, "unused", "a", { db });
  await assert.rejects(upsertEvent({ ...event("2026-10-20"), title: "Other spelling" }, PIN, "unused", "b", {
    db, fuzzyDuplicate: async () => { throw new Error("provider offline"); },
  }), /provider offline/);
  assert.equal(docs.size, 1);
});

test("same-day fuzzy candidate window is NYC/DST-aware, not server-local UTC", () => {
  for (const [stamp, start, end] of [
    ["2026-11-02T02:00:00Z", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
    ["2026-03-09T02:00:00Z", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
  ]) assert.deepEqual(nycDayBounds(Date.parse(stamp)), { start: Date.parse(start), end: Date.parse(end) });
});

test("malformed fuzzy decisions retry instead of silently treating them as no match", () => {
  assert.equal(parseDuplicateResponse("none", 2), null);
  assert.equal(parseDuplicateResponse("1", 2), 1);
  for (const text of ["", "1 maybe", "2", "-1", "NaN"]) assert.throws(() => parseDuplicateResponse(text, 2));
});

test("re-extracting the same source repairs a legacy day-one-only end without losing votes/category", async () => {
  const { docs, db } = fakeFirestore();
  const legacy = { ...event("2026-11-13"), title: "Holiday Train Show", sourceName: "nycforfree",
    sourceUrl: "https://www.nycforfree.co/events/holiday-train-show", temporalStatus: "limited_run" as const };
  await upsertEvent(legacy, PIN, "unused", "legacy", { db });
  docs.get("legacy")!.category = "popup";
  docs.get("legacy")!.thumbsUp = 7;
  const corrected = { ...legacy, endTimestamp: Date.parse("2027-02-22T00:00:00Z"),
    sourceOccurrenceId: "holiday-train-show|run|grand-central", temporalEvidence: "Runs through February 21" };
  assert.equal((await upsertEvent(corrected, PIN, "unused", "corrected", { db })).kind, "merged");
  assert.equal(docs.size, 1);
  assert.equal((docs.get("legacy")!.endTime as Timestamp).toMillis(), corrected.endTimestamp);
  assert.equal(docs.get("legacy")!.category, "popup");
  assert.equal(docs.get("legacy")!.thumbsUp, 7);
  assert.equal(docs.get("legacy")!.sourceOccurrenceId, corrected.sourceOccurrenceId);
});

test("stable source occurrence identity updates schedule and pin without duplicating the event", async () => {
  const { docs, db } = fakeFirestore();
  const e = { ...event("2026-11-13"), sourceOccurrenceId: "popup|run|venue" };
  await upsertEvent(e, PIN, "unused", "a", { db });
  const updated = { ...e, title: "Corrected source title", startTimestamp: e.startTimestamp + 3600_000,
    endTimestamp: e.endTimestamp + 2 * 86400_000, location: "Source venue, full address" };
  const changedPin = { ...PIN, latitude: 40.74, formattedAddress: updated.location };
  const result = await upsertEvent(updated, changedPin, "unused", "b", { db });
  assert.deepEqual(result, { kind: "merged", eventId: "a", match: "source-occurrence" });
  assert.equal(docs.size, 1);
  assert.equal((docs.get("a")!.startTime as Timestamp).toMillis(), updated.startTimestamp);
  assert.equal((docs.get("a")!.endTime as Timestamp).toMillis(), updated.endTimestamp);
  assert.equal(docs.get("a")!.latitude, changedPin.latitude);
});

test("different source occurrences do not merge even with the same title/place and overlapping clocks", async () => {
  const { docs, db } = fakeFirestore();
  const e = event("2026-11-13");
  for (const [id, key] of [["a", "tour|stop-a"], ["b", "tour|stop-b"]]) {
    const result = await upsertEvent({ ...e, sourceOccurrenceId: key }, PIN, "unused", id,
      { db, fuzzyDuplicate: async (_event, _start, candidates) => candidates[0]?.id ?? null });
    assert.equal(result.kind, "added");
  }
  assert.equal(docs.size, 2);
});

test("adding a different source URL cannot silently replace an existing event schedule", async () => {
  const { docs, db } = fakeFirestore();
  const e = event("2026-11-13");
  await upsertEvent(e, PIN, "unused", "a", { db });
  await upsertEvent({ ...e, sourceUrl: "https://other.example/event", endTimestamp: e.endTimestamp - 1800_000 },
    PIN, "unused", "b", { db });
  assert.equal((docs.get("a")!.endTime as Timestamp).toMillis(), e.endTimestamp);
});

test("non-overlapping sessions are excluded from fuzzy duplicate matching", async () => {
  const { docs, db } = fakeFirestore();
  const e = event("2026-11-13");
  await upsertEvent(e, PIN, "unused", "a", { db });
  await upsertEvent({ ...e, startTimestamp: e.startTimestamp + 7200_000, endTimestamp: e.endTimestamp + 7200_000 },
    PIN, "unused", "b", { db, fuzzyDuplicate: async (_event, _start, candidates) => {
      assert.equal(candidates.length, 0);
      return null;
    } });
  assert.equal(docs.size, 2);
});
