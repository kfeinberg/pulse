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
