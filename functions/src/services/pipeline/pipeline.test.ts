import assert from "node:assert/strict";
import test from "node:test";
import type { EventSource, ScrapedEvent } from "../../scrapers/base.js";
import type { ResolvedLocation } from "../geocoder.js";
import { ExtractionCache, type SeenItemStore } from "../extractionCache.js";
import {
  checkpointId,
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
  const store: PipelineStore = {
    async get(c, id) { return docs[c].get(id) ?? null; },
    async put(c, doc) { docs[c].set(doc.id, { ...doc }); },
    async setHeld(id, held) { const d = docs.items.get(id); if (d) d.held = held; },
    async list(c, since, until) { return [...docs[c].values()].filter((d) => d.createdAtMs >= since && d.createdAtMs <= until); },
    async quarantine(entry) {
      const id = quarantineId(entry.stage, entry.inputId);
      quarantined.set(id, { ...entry, id, createdAtMs: Date.now(), released: false });
    },
    async listQuarantine(stage, since) { return [...quarantined.values()].filter((q) => q.stage === stage && q.createdAtMs >= since); },
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
