import assert from "node:assert/strict";
import test from "node:test";
import type { EventSource, ScrapedEvent } from "../../scrapers/base.js";
import type { ResolvedLocation } from "../geocoder.js";
import { ExtractionCache, type SeenItemStore } from "../extractionCache.js";
import {
  checkpointId,
  checkpointDeletionPlan,
  COLLECTIONS,
  itemId,
  quarantineId,
  stableJson,
  type CheckpointCollection,
  type CheckpointDoc,
  type PipelineStore,
  type Stage,
  type StoredQuarantineEntry,
} from "./checkpoints.js";
import { evaluateSourceHealth } from "./circuitBreaker.js";
import { resolvedLocationViolations, scrapedEventViolations } from "./contracts.js";
import { checkpointExtracted, runExtractStage } from "./extract.js";
import { taskId } from "./queue.js";
import { parseReplayRequest, replay } from "./replay.js";
import { runGate, runGeocode, runWithDeadLetter, runWrite, type StageDeps, type StageTask } from "./stages.js";

function event(overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    title: "Fall Night Market",
    description: "Food and vendors",
    startTimestamp: Date.parse("2026-10-17T22:00:00Z"),
    endTimestamp: Date.parse("2026-10-18T02:00:00Z"),
    location: "Brooklyn Navy Yard, Brooklyn",
    category: "street_fair",
    sourceUrl: "https://example.com/market",
    sourceName: "fieldnotes",
    temporalStatus: "limited_run",
    temporalEvidence: "3 nights only, Oct 17–19",
    ...overrides,
  };
}

const PIN: ResolvedLocation = {
  latitude: 40.7, longitude: -73.97, formattedAddress: "Brooklyn Navy Yard", placeName: "Navy Yard",
  query: "Brooklyn Navy Yard", provider: "nominatim", osmId: 1, osmType: "way",
};

function memoryStore() {
  const docs: Record<CheckpointCollection, Map<string, CheckpointDoc>> = {
    items: new Map(), accepted: new Map(), pinned: new Map(), written: new Map(),
  };
  const quarantined = new Map<string, StoredQuarantineEntry>();
  const history = new Map<string, number[]>();
  const extracts = new Map<string, import("./checkpoints.js").ExtractCheckpoint>();
  const store: PipelineStore = {
    async getExtractRun(runId, source) { return extracts.get(`${runId}/${source}`) ?? null; },
    async saveExtractRun(runId, source, checkpoint) { const key = `${runId}/${source}`; if (!extracts.has(key)) extracts.set(key, checkpoint); return extracts.get(key)!; },
    async get(c, id) { return docs[c].get(id) ?? null; },
    async put(c, doc) { if (!docs[c].has(doc.id)) docs[c].set(doc.id, { ...doc }); },
    async setHeld(id, held) { const d = docs.items.get(id); if (d) d.held = held; },
    async list(c, since, until, limit, source) { return [...docs[c].values()].filter((d) => d.createdAtMs >= since && d.createdAtMs <= until && (!source || d.source === source)).slice(0, limit); },
    async quarantine(entry) {
      const id = quarantineId(entry.stage, entry.inputId);
      quarantined.set(id, { ...entry, id, createdAtMs: Date.now(), released: false });
    },
    async getQuarantine(stage, inputId) { return quarantined.get(quarantineId(stage, inputId)) ?? null; },
    async listQuarantine(stage, since, limit, filters = {}) { return [...quarantined.values()].filter((q) => q.stage === stage && !q.released && q.createdAtMs >= since && q.createdAtMs <= (filters.untilMs ?? Infinity) && (!filters.source || q.source === filters.source)).slice(0, limit); },
    async markReleased(id) { const q = quarantined.get(id); if (q) q.released = true; },
    async sourceHistory(source) { return history.get(source) ?? []; },
    async recordSourceCount(source, listed, keep) { history.set(source, [...(history.get(source) ?? []), listed].slice(-keep)); },
  };
  return { store, docs, quarantined, history };
}

function harness(overrides: Partial<StageDeps> = {}) {
  const mem = memoryStore();
  const queued: Array<{ stage: Stage; task: StageTask }> = [];
  const upserts: string[] = [];
  const deps: StageDeps = {
    store: mem.store,
    enqueue: async (stage, task) => { queued.push({ stage, task }); },
    geocode: async () => PIN,
    upsert: async (_e, _g, addId) => { upserts.push(addId); return { kind: "added", eventId: addId }; },
    ...overrides,
  };
  return { ...mem, queued, upserts, deps };
}

function seedItem(mem: ReturnType<typeof memoryStore>, e: unknown, held = false): string {
  const id = itemId("fieldnotes", e);
  mem.docs.items.set(id, { id, source: "fieldnotes", runId: "run1", createdAtMs: Date.now(), held, data: { event: e } });
  return id;
}

async function drain(h: ReturnType<typeof harness>): Promise<void> {
  const runners = { gate: runGate, geocode: runGeocode, write: runWrite };
  while (h.queued.length) {
    const { stage, task } = h.queued.shift()!;
    await runners[stage](task, h.deps);
  }
}

// ── ids ──
test("checkpoint ids are deterministic and change with stage version", () => {
  assert.equal(checkpointId("geocode", "abc"), checkpointId("geocode", "abc"));
  assert.notEqual(checkpointId("geocode", "abc", 1), checkpointId("geocode", "abc", 2));
  assert.notEqual(checkpointId("geocode", "abc"), checkpointId("write", "abc"));
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(itemId("dice", { a: 1, b: 2 }), itemId("dice", { b: 2, a: 1 }));
});

test("task ids dedupe redeliveries but not replays", () => {
  assert.equal(taskId("gate", { inputId: "x" }), taskId("gate", { inputId: "x" }));
  assert.notEqual(taskId("gate", { inputId: "x" }), taskId("gate", { inputId: "x", replayId: "r1" }));
  assert.match(taskId("write", { inputId: "x" }), /^[a-f0-9]{32}-write$/);
});

// ── contracts ──
test("contracts accept a valid event and name every violation", () => {
  assert.deepEqual(scrapedEventViolations(event()), []);
  const bad = scrapedEventViolations({ ...event(), title: "", category: "museum", endTimestamp: 0, temporalEvidence: "" });
  assert.ok(bad.includes("title is missing"));
  assert.ok(bad.some((v) => v.includes("unknown category")));
  assert.ok(bad.includes("endTimestamp is before startTimestamp"));
  assert.ok(bad.includes("temporalEvidence is missing"));
  assert.deepEqual(resolvedLocationViolations(null), []);
  assert.deepEqual(resolvedLocationViolations(PIN), []);
  assert.ok(resolvedLocationViolations({ ...PIN, latitude: 200 }).includes("latitude is invalid"));
});

// ── circuit breaker ──
test("circuit breaker learns first, then trips on silent zeros and sharp drops", () => {
  assert.equal(evaluateSourceHealth(0, [40, 42]).tripped, false);
  assert.equal(evaluateSourceHealth(0, [40, 42, 38]).tripped, true);
  assert.equal(evaluateSourceHealth(5, [40, 42, 38]).tripped, true);
  assert.equal(evaluateSourceHealth(30, [40, 42, 38]).tripped, false);
  assert.equal(evaluateSourceHealth(0, [2, 1, 3]).tripped, false);
});

// ── stages ──
test("an item flows gate → geocode → write through its own checkpoints", async () => {
  const h = harness();
  const id = seedItem(h, event());
  h.queued.push({ stage: "gate", task: { inputId: id } });
  await drain(h);
  assert.equal(h.docs.accepted.size, 1);
  assert.equal(h.docs.pinned.size, 1);
  assert.equal(h.docs.written.size, 1);
  assert.deepEqual([...h.docs.pinned.values()][0].data.geo, PIN);
  assert.equal(h.upserts.length, 1);
});

test("gate quarantines contract violations and permanent attractions", async () => {
  const h = harness();
  const broken = seedItem(h, { ...event(), title: "" });
  const permanent = seedItem(h, event({ title: "Color Factory", temporalStatus: "permanent_attraction" as never }));
  assert.equal((await runGate({ inputId: broken }, h.deps)).status, "quarantined");
  assert.equal((await runGate({ inputId: permanent }, h.deps)).status, "quarantined");
  assert.equal(h.quarantined.size, 2);
  assert.equal(h.queued.length, 0);
});

test("a redelivered write task is a no-op; a replay reruns it", async () => {
  const h = harness();
  const id = seedItem(h, event());
  h.queued.push({ stage: "gate", task: { inputId: id } });
  await drain(h);
  const pinnedId = [...h.docs.pinned.keys()][0];
  assert.equal((await runWrite({ inputId: pinnedId }, h.deps)).status, "skipped");
  assert.equal((await runWrite({ inputId: pinnedId, replayId: "r1" }, h.deps)).status, "done");
  assert.equal(h.upserts.length, 2);
});

test("a transient failure retries, then dead-letters on the last attempt", async () => {
  const h = harness({ geocode: async () => { throw new Error("Nominatim returned 429"); } });
  const id = seedItem(h, event());
  await runGate({ inputId: id }, h.deps);
  const acceptedId = h.queued.shift()!.task.inputId;
  await assert.rejects(runWithDeadLetter("geocode", { inputId: acceptedId }, 0, 3, h.deps));
  const last = await runWithDeadLetter("geocode", { inputId: acceptedId }, 2, 3, h.deps);
  assert.equal(last.status, "quarantined");
  assert.match([...h.quarantined.values()][0].reason, /dead-letter after 3 attempts/);
  assert.equal(h.docs.pinned.size, 0);
});

// ── extract stage + circuit breaker ──
function source(name: string, events: ScrapedEvent[]): EventSource {
  return { name, scrape: async () => events };
}
const noopCache: SeenItemStore = { findExisting: async () => new Set(), save: async () => {} };

test("extract checkpoints each item and queues it for the gate", async () => {
  const h = harness();
  const summary = await runExtractStage(source("fieldnotes", [event(), event({ title: "Other" })]), "run1", h.deps);
  assert.equal(summary.queued, 2);
  assert.equal(h.docs.items.size, 2);
  assert.deepEqual(h.queued.map((q) => q.stage), ["gate", "gate"]);
  assert.deepEqual(h.history.get("fieldnotes"), [2]);
});

test("a tripped breaker holds the run's items in quarantine without queueing them", async () => {
  const h = harness();
  h.history.set("dice", [40, 42, 38]);
  const cache = new ExtractionCache("dice", { store: noopCache });
  const summary = await checkpointExtracted("dice", [event({ sourceName: "dice" })], cache, "run2", h.deps, { breaker: true });
  assert.equal(summary.health.tripped, true);
  assert.equal(summary.held, 1);
  assert.equal(h.queued.length, 0);
  assert.equal([...h.docs.items.values()][0].held, true);
  assert.match([...h.quarantined.values()][0].reason, /circuit breaker/);
  assert.deepEqual(h.history.get("dice"), [40, 42, 38]);
});

// ── replay ──
test("replaying geocode for one source reruns geocode and write but not extraction", async () => {
  const h = harness();
  const a = seedItem(h, event());
  const bId = itemId("dice", event({ title: "Dice show", sourceName: "dice" }));
  h.docs.items.set(bId, { id: bId, source: "dice", runId: "run1", createdAtMs: Date.now(), data: { event: event({ title: "Dice show", sourceName: "dice" }) } });
  h.queued.push({ stage: "gate", task: { inputId: a } }, { stage: "gate", task: { inputId: bId } });
  await drain(h);
  assert.equal(h.upserts.length, 2);

  const result = await replay({ stage: "geocode", source: "dice" }, h.deps);
  assert.equal(result.queued, 1);
  assert.ok(h.queued.every((q) => q.task.replayId === result.replayId));
  await drain(h);
  assert.equal(h.upserts.length, 3);
});

test("releasing quarantine re-queues held items for the gate", async () => {
  const h = harness();
  h.history.set("dice", [40, 42, 38]);
  const cache = new ExtractionCache("dice", { store: noopCache });
  await checkpointExtracted("dice", [event({ sourceName: "dice" })], cache, "run2", h.deps, { breaker: true });
  const result = await replay({ stage: "gate", source: "dice", releaseQuarantine: true }, h.deps);
  assert.equal(result.queued, 1);
  assert.equal([...h.docs.items.values()][0].held, false);
  await drain(h);
  assert.equal(h.upserts.length, 1);
  assert.equal([...h.quarantined.values()][0].released, true);
});

test("replay requests are validated", () => {
  assert.throws(() => parseReplayRequest({ stage: "extract" }), /stage must be one of/);
  assert.throws(() => parseReplayRequest({ stage: "geocode", since: "not a date" }), /not a valid date/);
  const parsed = parseReplayRequest({ stage: "geocode", source: "dice", since: "2026-10-17" });
  assert.equal(parsed.sinceMs, Date.parse("2026-10-17"));
});

// Crash windows and replay delivery tests: the queue is at-least-once, not
// an in-memory FIFO, and successful provider work must survive enqueue errors.
test("geocode retry resumes its durable output after a downstream enqueue failure", async () => {
  let lookups = 0;
  let enqueues = 0;
  const h = harness({
    geocode: async () => { lookups++; if (lookups > 1) throw new Error("provider now offline"); return PIN; },
    enqueue: async () => { if (++enqueues === 1) throw new Error("queue unavailable"); },
  });
  const id = seedItem(h, event());
  await runGate({ inputId: id }, { ...h.deps, enqueue: async () => {} });
  const task = { inputId: [...h.docs.accepted.keys()][0] };
  await assert.rejects(runGeocode(task, h.deps), /queue unavailable/);
  assert.equal(h.docs.pinned.size, 1);
  assert.equal((await runGeocode(task, h.deps)).status, "done");
  assert.equal(lookups, 1);
  assert.equal(enqueues, 2);
});

test("replay redeliveries are idempotent and cannot replace an earlier pin", async () => {
  let lookups = 0;
  const h = harness({ geocode: async () => ({ ...PIN, latitude: PIN.latitude + ++lookups / 100 }) });
  const id = seedItem(h, event());
  await runGate({ inputId: id }, h.deps);
  const inputId = [...h.docs.accepted.keys()][0];
  const original = await runGeocode({ inputId }, h.deps);
  const firstPin = [...h.docs.pinned.values()][0].data.geo;
  const task = { inputId, replayId: "replay-1" };
  const replayed = await runGeocode(task, h.deps);
  await runGeocode(task, h.deps);
  assert.equal(lookups, 2);
  assert.equal(h.docs.pinned.size, 2);
  assert.notDeepEqual(original, replayed);
  assert.deepEqual([...h.docs.pinned.values()][0].data.geo, firstPin);
});

test("write redelivery of the same replay does not repeat the upsert", async () => {
  const h = harness();
  const id = seedItem(h, event());
  h.queued.push({ stage: "gate", task: { inputId: id } });
  await drain(h);
  const task = { inputId: [...h.docs.pinned.keys()][0], replayId: "replay-1" };
  await runWrite(task, h.deps);
  await runWrite(task, h.deps);
  assert.equal(h.upserts.length, 2);
});

test("single-input replay honors source, dates, existence, and circuit holds", async () => {
  const h = harness();
  const inputId = seedItem(h, event());
  for (const request of [
    { stage: "gate" as const, inputId, source: "dice" },
    { stage: "gate" as const, inputId, untilMs: 0 },
    { stage: "gate" as const, inputId: "missing" },
  ]) assert.equal((await replay(request, h.deps)).queued, 0);
  await h.store.setHeld(inputId, true);
  assert.equal((await replay({ stage: "gate", inputId }, h.deps)).queued, 0);
  assert.equal(h.queued.length, 0);
});

test("replay rejects inverted windows and malformed selectors", () => {
  assert.throws(() => parseReplayRequest({ stage: "gate", since: "2026-10-20", until: "2026-10-17" }));
  assert.throws(() => parseReplayRequest({ stage: "gate", source: 42 }));
  assert.throws(() => parseReplayRequest({ stage: "gate", inputId: "a/b" }));
  assert.throws(() => parseReplayRequest({ stage: "gate", releaseQuarantine: "yes" }));
});

test("extraction checkpoints from another run cannot hold a previous healthy delivery", async () => {
  const h = harness();
  const cache = () => new ExtractionCache("dice", { store: noopCache });
  const e = event({ sourceName: "dice" });
  await checkpointExtracted("dice", [e], cache(), "healthy", h.deps, { breaker: false });
  const healthyTask = h.queued.shift()!.task;
  h.history.set("dice", [40, 42, 38]);
  await checkpointExtracted("dice", [e], cache(), "broken", h.deps, { breaker: true });
  assert.equal(h.docs.items.get(healthyTask.inputId)!.runId, "healthy");
  assert.equal(h.docs.items.get(healthyTask.inputId)!.held, false);
  assert.equal(h.docs.items.size, 2);
});

test("checkpoint contracts reject finite but unrepresentable dates and incomplete pins", () => {
  assert.ok(scrapedEventViolations(event({ startTimestamp: 1e30, endTimestamp: 1e30 })).length > 0);
  const { osmType: _osmType, ...incomplete } = PIN;
  assert.ok(resolvedLocationViolations(incomplete).length > 0);
});

test("roundup source counts stay stable when the extraction cache skips every item", async () => {
  const h = harness();
  const saved = new Set<string>();
  const store: SeenItemStore = { findExisting: async (keys) => new Set(keys.filter((key) => saved.has(key))), save: async (keys) => { keys.forEach((key) => saved.add(key)); } };
  for (let i = 0; i < 4; i++) {
    const cache = new ExtractionCache("fieldnotes", { store });
    const fresh = await cache.filterNew(["roundup with 30 events"], (text) => text);
    cache.stage(fresh.keys);
    const events = fresh.items.length ? Array.from({ length: 30 }, (_, j) => event({ title: `Market ${j}` })) : [];
    const summary = await checkpointExtracted("fieldnotes", events, cache, `run${i}`, h.deps, { breaker: true });
    assert.equal(summary.listed, 1);
    assert.equal(summary.health.tripped, false);
  }
  assert.deepEqual(h.history.get("fieldnotes"), [1, 1, 1, 1]);
});

test("quarantine release remains unreleased when worker validation fails again", async () => {
  const h = harness();
  const inputId = seedItem(h, { ...event(), title: "" });
  await runGate({ inputId }, h.deps);
  await replay({ stage: "gate", inputId, releaseQuarantine: true }, h.deps);
  assert.equal([...h.quarantined.values()][0].released, false);
  await drain(h);
  assert.equal([...h.quarantined.values()][0].released, false);
});

test("replay size and date bounds reject before enqueueing any task", async () => {
  const h = harness();
  for (let i = 0; i < 1001; i++) seedItem(h, event({ title: `Event ${i}` }));
  await assert.rejects(replay({ stage: "gate" }, h.deps), /too many/);
  await assert.rejects(replay({ stage: "gate", sinceMs: 0, untilMs: 15 * 24 * 60 * 60 * 1000 }, h.deps), /at most 14/);
  assert.equal(h.queued.length, 0);
});

test("missing input retries and eventually dead-letters instead of acknowledging data loss", async () => {
  const h = harness();
  await assert.rejects(runWithDeadLetter("gate", { inputId: "missing" }, 0, 3, h.deps), /not found/);
  assert.equal((await runWithDeadLetter("gate", { inputId: "missing" }, 2, 3, h.deps)).status, "quarantined");
  assert.equal(h.quarantined.size, 1);
});

test("14-day cleanup preserves upstream references of recent outputs and quarantine", () => {
  const docs = [
    { collection: COLLECTIONS.items, id: "old-item", createdAtMs: 1, runId: "run", data: {} },
    { collection: COLLECTIONS.accepted, id: "old-accepted", createdAtMs: 2, runId: "run", data: { inputId: "old-item" } },
    { collection: COLLECTIONS.pinned, id: "recent-pin", createdAtMs: 100, runId: "run", data: { inputId: "old-accepted" } },
    { collection: COLLECTIONS.runs, id: "run", createdAtMs: 1, data: {} },
    { collection: COLLECTIONS.items, id: "quarantined", createdAtMs: 1, data: {} },
    { collection: COLLECTIONS.quarantine, id: "q", createdAtMs: 100, stage: "gate", inputId: "quarantined", data: {} },
    { collection: COLLECTIONS.items, id: "obsolete", createdAtMs: 1, data: {} },
  ];
  assert.deepEqual(checkpointDeletionPlan(docs, 50), new Set([`${COLLECTIONS.items}/obsolete`]));
});

test("retaining an old extraction memo also retains its sibling items", () => {
  const run = { collection: COLLECTIONS.runs, id: "run", createdAtMs: 1, data: { extractions: { source: { itemIds: ["a", "b"] } } } };
  const docs = [
    run,
    { collection: COLLECTIONS.items, id: "a", createdAtMs: 1, runId: "run", data: {} },
    { collection: COLLECTIONS.items, id: "b", createdAtMs: 1, runId: "run", data: {} },
    { collection: COLLECTIONS.accepted, id: "accepted", createdAtMs: 100, runId: "run", data: { inputId: "a" } },
  ];
  assert.equal(checkpointDeletionPlan(docs, 50).size, 0);
});

test("one quarantine release is not blocked by 1001 unrelated source entries", async () => {
  const h = harness();
  for (let i = 0; i < 1001; i++) {
    const inputId = seedItem(h, event({ title: `Unrelated ${i}` }), true);
    await h.store.quarantine({ stage: "gate", inputId, source: "fieldnotes", runId: "run", reason: "held" });
  }
  const e = event({ sourceName: "dice" });
  const inputId = itemId("dice", e);
  h.docs.items.set(inputId, { id: inputId, source: "dice", runId: "run", createdAtMs: Date.now(), held: true, data: { event: e } });
  await h.store.quarantine({ stage: "gate", inputId, source: "dice", runId: "run", reason: "held" });
  assert.equal((await replay({ stage: "gate", source: "dice", inputId, releaseQuarantine: true }, h.deps)).queued, 1);
  assert.equal(h.queued.length, 1);
});

test("extract retry resumes durable items after partial enqueue without calling the source again", async () => {
  let sourceCalls = 0;
  let queueCalls = 0;
  const h = harness({ enqueue: async () => { if (++queueCalls === 1) throw new Error("queue unavailable"); } });
  const source: EventSource = { name: "fieldnotes", scrape: async () => { sourceCalls++; return [event({ title: `Nondeterministic result ${sourceCalls}` })]; } };
  await assert.rejects(runExtractStage(source, "run", h.deps), /queue unavailable/);
  const ids = [...h.docs.items.keys()];
  assert.equal((await runExtractStage(source, "run", h.deps)).queued, 1);
  assert.equal(sourceCalls, 1);
  assert.equal(queueCalls, 2);
  assert.deepEqual([...h.docs.items.keys()], ids);
});

test("saved extraction cache keys commit on handoff retry without replacing source output", async () => {
  const saved = new Set<string>();
  const cacheStore: SeenItemStore = { findExisting: async () => new Set(), save: async (keys) => { keys.forEach((key) => saved.add(key)); } };
  const first = new ExtractionCache("fieldnotes", { store: cacheStore });
  const fresh = await first.filterNew(["source card"], (s) => s);
  first.stage(fresh.keys);
  const h = harness({ enqueue: async () => { throw new Error("queue unavailable"); } });
  await assert.rejects(checkpointExtracted("fieldnotes", [event()], first, "run", h.deps, { breaker: false }));
  assert.equal(saved.size, 0);
  const retry = new ExtractionCache("fieldnotes", { store: cacheStore });
  const result = await checkpointExtracted("fieldnotes", [], retry, "run", { ...h.deps, enqueue: async () => {} }, { breaker: false });
  assert.equal(result.extracted, 1);
  assert.deepEqual(saved, new Set(fresh.keys));
  assert.equal(h.docs.items.size, 1);
});
