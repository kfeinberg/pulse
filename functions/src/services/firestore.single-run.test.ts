import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { ScrapedEvent } from "../scrapers/base.js";
import type { ResolvedLocation } from "./geocoder.js";
import { upsertEvent } from "./firestore.js";

// Offline fixtures use the parent's observed identity/time/location subsets.
// Engagement, descriptions and unobserved coordinates are explicitly synthetic;
// these are not full live-document exports. All database/provider work is mocked.
function event(overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  const slug = "skullpanda-popup";
  return {
    title: "SKULLPANDA", description: "Source-backed continuous pop-up fixture",
    location: "Fixture pop-up, 123 West 14th Street, Manhattan", category: "popup",
    sourceName: "nycforfree", sourceUrl: `https://www.nycforfree.co/events/${slug}`,
    sourceOccurrenceId: `${slug}|run|single`, temporalStatus: "limited_run",
    temporalEvidence: "November 13 through November 15",
    startTimestamp: Date.parse("2026-11-13T15:00:00Z"),
    endTimestamp: Date.parse("2026-11-16T04:59:00Z"),
    ...overrides,
  };
}
function pin(input: ScrapedEvent): ResolvedLocation {
  return { latitude: 40.738, longitude: -74.001, formattedAddress: input.location,
    placeName: "Fixture pop-up", query: input.sourceUrl, provider: "nycforfree", osmId: null, osmType: null };
}
function legacy(input: ScrapedEvent, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: input.title, description: "Existing curated description", location: "Fixture pop-up, 123 East 14th Street, Manhattan",
    category: "happening", latitude: 40.732, longitude: -73.989,
    resolvedAddress: "123 East 14th Street, Manhattan", geocodingProvider: "nominatim",
    sourceUrl: input.sourceUrl, sourceUrls: [input.sourceUrl], temporalStatus: "limited_run",
    temporalEvidence: "Legacy day-one-only schedule", startTime: Timestamp.fromMillis(input.startTimestamp),
    endTime: Timestamp.fromMillis(Date.parse("2026-11-14T04:59:00Z")),
    thumbsUp: 9, thumbsDown: 2, interested: 12, createdAt: Timestamp.fromMillis(1),
    ...overrides,
  };
}
function fakeFirestore(rows: Array<[string, Record<string, unknown>]>) {
  const docs = new Map(rows);
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const queries: Array<Array<[string, string, unknown]>> = [];
  let fuzzyCalls = 0;
  const snapshot = (id: string) => ({ id, exists: docs.has(id), data: () => docs.get(id), ref: reference(id) });
  const reference = (id: string) => ({
    id, get: async () => snapshot(id),
    update: async (data: Record<string, unknown>) => { writes.push({ id, data }); docs.set(id, { ...docs.get(id), ...data }); },
    create: async (data: Record<string, unknown>) => {
      assert.ok(!docs.has(id)); writes.push({ id, data }); docs.set(id, data);
    },
  });
  const scalar = (value: unknown) => value instanceof Timestamp ? value.toMillis() : value;
  const query = (clauses: Array<[string, string, unknown]> = []) => ({
    doc: reference,
    where: (field: string, op: string, value: unknown) => query([...clauses, [field, op, value]]),
    get: async () => {
      queries.push(clauses);
      const rows = [...docs].filter(([, data]) => clauses.every(([field, op, value]) => {
        const a = scalar(data[field]) as string | number;
        const b = scalar(value) as string | number;
        if (op === "==") return a === b;
        if (op === ">=") return a >= b;
        if (op === "<") return a < b;
        throw new Error(`Unexpected query operator ${op}`);
      })).map(([id]) => snapshot(id));
      return { docs: rows, empty: rows.length === 0 };
    },
  });
  const db = { collection: (name: string) => { assert.equal(name, "events"); return query(); } } as unknown as Firestore;
  const noFuzzy = async (): Promise<null> => { fuzzyCalls++; throw new Error("Offline fuzzy sentinel: deterministic migration required"); };
  const allowNoMatch = async (): Promise<null> => { fuzzyCalls++; return null; };
  return { docs, writes, queries, db, noFuzzy, allowNoMatch, fuzzyCalls: () => fuzzyCalls };
}

for (const fixture of [
  {
    title: "SKULLPANDA Off Mode Experience", slug: "skullpanda-off-mode-experience", oldId: "8QN4wgiPqebUVgLNdxXO",
    oldLocation: "423 East 14th Street, New York, NY 10009, Manhattan",
    location: "Manhattan, 423 West 14th Street, New York, NY, USA",
    sourceAddress: "423 West 14th Street, New York, NY, USA", latitude: 40.7417079, longitude: -74.0064341,
    oldStart: "2026-10-16T14:00:00Z", oldEnd: "2026-12-01T00:00:00Z",
    start: "2026-10-16T14:00:00Z", end: "2026-12-01T00:00:00Z",
  },
  {
    title: "The Ordinary Post", slug: "the-ordinary-post", oldId: "c921c499130ded3db649b48d70408cba78c4f9c0",
    oldLocation: "21 Greene St, New York, NY, Manhattan",
    location: "Manhattan, 21 Greene St, New York, NY10013, USA",
    sourceAddress: "21 Greene St, New York, NY10013, USA", latitude: 40.721, longitude: -74.0013, // synthetic pin
    oldStart: "2026-11-14T14:00:00Z", oldEnd: "2026-11-14T22:00:00Z",
    start: "2026-11-14T15:00:00Z", end: "2026-11-15T23:00:00Z",
  },
]) {
  test(`${fixture.title} single-run recovery corrects old pin/address/end without LLM or engagement loss`, async () => {
    const { title, slug, oldId } = fixture;
    const input = event({ title, sourceUrl: `https://www.nycforfree.co/events/${slug}`, sourceOccurrenceId: `${slug}|run|single`,
      location: fixture.location, startTimestamp: Date.parse(fixture.start), endTimestamp: Date.parse(fixture.end) });
    const before = legacy(input, { location: fixture.oldLocation,
      startTime: Timestamp.fromMillis(Date.parse(fixture.oldStart)), endTime: Timestamp.fromMillis(Date.parse(fixture.oldEnd)) });
    const mem = fakeFirestore([[oldId, before]]);
    const geo = { ...pin(input), latitude: fixture.latitude, longitude: fixture.longitude, formattedAddress: fixture.sourceAddress };
    assert.deepEqual(await upsertEvent(input, geo, "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.noFuzzy }),
      { kind: "merged", eventId: oldId, match: "source-occurrence" });
    assert.equal(mem.docs.size, 1);
    const saved = mem.docs.get(oldId)!;
    for (const key of ["title", "description", "category", "thumbsUp", "thumbsDown", "interested", "createdAt"]) assert.deepEqual(saved[key], before[key], key);
    assert.equal(saved.location, input.location);
    assert.equal(saved.resolvedAddress, geo.formattedAddress);
    assert.equal(saved.latitude, geo.latitude);
    assert.equal(saved.longitude, geo.longitude);
    assert.equal((saved.endTime as Timestamp).toMillis(), input.endTimestamp);
    assert.equal(saved.sourceOccurrenceId, input.sourceOccurrenceId);
    assert.equal(mem.fuzzyCalls(), 0);
    assert.ok(mem.queries.some((clauses) => clauses.length === 1 && clauses[0][0] === "sourceUrl" && clauses[0][2] === input.sourceUrl));
  });
}

test("canonical-title variant with exact primary source URL migrates but preserves existing display title", async () => {
  const input = event();
  const title = "  SKULLPANDA! ";
  const mem = fakeFirestore([["legacy", legacy(input, { title })]]);
  assert.equal((await upsertEvent(input, pin(input), "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.noFuzzy })).kind, "merged");
  assert.equal(mem.docs.get("legacy")!.title, title);
  assert.equal(mem.fuzzyCalls(), 0);
});

for (const [name, start] of [
  ["fall-back NYC day includes prior UTC evening", "2026-11-02T02:00:00Z"],
  ["spring-forward NYC day includes prior UTC evening", "2026-03-09T02:00:00Z"],
]) {
  test(name, async () => {
    const input = event({ startTimestamp: Date.parse(start), endTimestamp: Date.parse(start) + 2 * 86400_000 });
    const opening = name.startsWith("fall") ? Date.parse("2026-11-01T05:30:00Z") : Date.parse("2026-03-08T06:30:00Z");
    const mem = fakeFirestore([["legacy", legacy(input, { startTime: Timestamp.fromMillis(opening), endTime: Timestamp.fromMillis(opening + 3600_000) })]]);
    assert.equal((await upsertEvent(input, pin(input), "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.noFuzzy })).kind, "merged");
    assert.equal(mem.fuzzyCalls(), 0);
  });
}

test("all qualifying legacy candidates are examined; ambiguity throws before writes or fuzzy", async () => {
  const input = event();
  const mem = fakeFirestore([["first", legacy(input)], ["second", legacy(input, { title: "SKULLPANDA!" })]]);
  const before = [...mem.docs];
  await assert.rejects(upsertEvent(input, pin(input), "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.noFuzzy }), /Ambiguous legacy single-run source occurrence/);
  assert.equal(mem.writes.length, 0);
  assert.equal(mem.fuzzyCalls(), 0);
  assert.deepEqual([...mem.docs], before);
});

test("a conflicting existing source occurrence ID is not a legacy candidate or an ambiguity", async () => {
  const input = event();
  const conflict = legacy(input, { sourceOccurrenceId: "skullpanda-popup|run|another-place" });
  const mem = fakeFirestore([["legacy", legacy(input)], ["other", conflict]]);
  assert.deepEqual(await upsertEvent(input, pin(input), "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.noFuzzy }),
    { kind: "merged", eventId: "legacy", match: "source-occurrence" });
  assert.deepEqual(mem.docs.get("other"), conflict);
  assert.equal(mem.fuzzyCalls(), 0);
});

const exclusions: Array<[string, (e: ScrapedEvent) => ScrapedEvent, (row: Record<string, unknown>) => Record<string, unknown>]> = [
  ["different NYC opening day", e => e, row => ({ ...row, startTime: Timestamp.fromMillis(Date.parse("2026-11-14T15:00:00Z")), endTime: Timestamp.fromMillis(Date.parse("2026-11-15T04:59:00Z")) })],
  ["same month/day but different year", e => e, row => ({ ...row, startTime: Timestamp.fromMillis(Date.parse("2025-11-13T15:00:00Z")), endTime: Timestamp.fromMillis(Date.parse("2025-11-14T04:59:00Z")) })],
  ["different canonical title", e => e, row => ({ ...row, title: "Another pop-up" })],
  ["different primary source URL", e => e, row => ({ ...row, sourceUrl: "https://www.nycforfree.co/events/another" })],
  ["source URL only in conflated secondary links", e => e, row => ({ ...row, sourceUrl: "https://www.nycforfree.co/events/another", sourceUrls: ["https://www.nycforfree.co/events/another", row.sourceUrl] })],
  ["explicit conflicting occurrence ID", e => e, row => ({ ...row, sourceOccurrenceId: "skullpanda-popup|run|other" })],
  ["explicit null occurrence ID is not absence", e => e, row => ({ ...row, sourceOccurrenceId: null })],
  ["explicit empty occurrence ID is not absence", e => e, row => ({ ...row, sourceOccurrenceId: "" })],
  ["legacy scheduled session", e => e, row => ({ ...row, temporalStatus: "scheduled_event" })],
  ["invalid legacy end", e => e, row => ({ ...row, endTime: Timestamp.fromMillis(0) })],
  ["nonfinite legacy end", e => e, row => ({ ...row, endTime: { toMillis: () => Infinity } })],
  ["nonfinite legacy start", e => e, row => ({ ...row, startTime: { toMillis: () => NaN } })],
  ["different incoming source", e => ({ ...e, sourceName: "other" }), row => row],
  ["incoming scheduled session", e => ({ ...e, temporalStatus: "scheduled_event" }), row => row],
  ["multi-location run identity", e => ({ ...e, sourceOccurrenceId: "skullpanda-popup|run|west-14th" }), row => row],
  ["session identity", e => ({ ...e, sourceOccurrenceId: "skullpanda-popup|2026-11-13|10:00|single" }), row => row],
  ["false single identity suffix", e => ({ ...e, sourceOccurrenceId: "skullpanda-popup|run|single-other" }), row => row],
  ["identity has wrong source slug", e => ({ ...e, sourceOccurrenceId: "other|run|single" }), row => row],
  ["untrusted URL domain", e => ({ ...e, sourceUrl: "https://www.nycforfree.co.evil.invalid/events/skullpanda-popup" }), row => row],
  ["HTTP not trusted HTTPS", e => ({ ...e, sourceUrl: "http://www.nycforfree.co/events/skullpanda-popup" }), row => row],
  ["listing URL not event detail", e => ({ ...e, sourceUrl: "https://www.nycforfree.co/events" }), row => row],
];
for (const [name, changeEvent, changeRow] of exclusions) {
  test(`migration excludes ${name}`, async () => {
    const input = changeEvent(event());
    const before = changeRow(legacy(input));
    const mem = fakeFirestore([["legacy", before]]);
    const result = await upsertEvent(input, pin(input), "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.allowNoMatch });
    assert.notDeepEqual(result, { kind: "merged", eventId: "legacy", match: "source-occurrence" });
    assert.deepEqual(mem.docs.get("legacy"), before);
    assert.equal(mem.writes.some(w => w.id === "legacy"), false);
  });
}

for (const [name, changePin] of [
  ["null pin", () => null],
  ["outside NYC", (g: ResolvedLocation) => ({ ...g, latitude: 41 })],
  ["nonfinite pin", (g: ResolvedLocation) => ({ ...g, longitude: NaN })],
  ["bare latitude/longitude", () => ({ latitude: 40.738, longitude: -74.001 })],
  ["unknown provider", (g: ResolvedLocation) => ({ ...g, provider: "model" })],
  ["mismatched source pin provenance", (g: ResolvedLocation) => ({ ...g, query: "https://www.nycforfree.co/events/another" })],
] as Array<[string, (g: ResolvedLocation) => unknown]>) {
  test(`migration rejects ${name} before legacy writes`, async () => {
    const input = event();
    const before = legacy(input);
    const mem = fakeFirestore([["legacy", before]]);
    await assert.rejects(upsertEvent(input, changePin(pin(input)) as ResolvedLocation | null, "unused", "incoming",
      { db: mem.db, fuzzyDuplicate: mem.noFuzzy }), /Offline fuzzy sentinel/);
    assert.deepEqual(mem.docs.get("legacy"), before);
    assert.equal(mem.writes.length, 0);
  });
}

test("a verified NYC Nominatim pin also permits the unique legacy single-run migration", async () => {
  const input = event();
  const mem = fakeFirestore([["legacy", legacy(input)]]);
  const geo: ResolvedLocation = { ...pin(input), provider: "nominatim", query: input.location, osmId: 42, osmType: "node" };
  assert.deepEqual(await upsertEvent(input, geo, "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.noFuzzy }),
    { kind: "merged", eventId: "legacy", match: "source-occurrence" });
  assert.equal(mem.docs.get("legacy")!.osmId, 42);
  assert.equal(mem.fuzzyCalls(), 0);
});

test("normal stable source-occurrence match still precedes legacy migration", async () => {
  const input = event();
  const mem = fakeFirestore([["stable", legacy(input, { sourceOccurrenceId: input.sourceOccurrenceId })], ["legacy", legacy(input)]]);
  assert.deepEqual(await upsertEvent(input, pin(input), "unused", "incoming", { db: mem.db, fuzzyDuplicate: mem.noFuzzy }),
    { kind: "merged", eventId: "stable", match: "source-occurrence" });
  assert.equal(mem.docs.get("legacy")!.sourceOccurrenceId, undefined);
  assert.equal(mem.fuzzyCalls(), 0);
});
