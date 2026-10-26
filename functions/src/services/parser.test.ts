import assert from "node:assert/strict";
import test from "node:test";
import type { ScrapedEvent } from "../scrapers/base.js";
import { ExtractionCache, type SeenItemStore } from "./extractionCache.js";
import { MAX_EXTRACTION_CONTENT_CHARS, parseEventTimes, parseExtractionResponse, parseNewItems } from "./parser.js";

function memoryStore(): SeenItemStore & { saved: Set<string> } {
  const saved = new Set<string>();
  return {
    saved,
    async findExisting(keys) { return new Set(keys.filter((key) => saved.has(key))); },
    async save(keys) { for (const key of keys) saved.add(key); },
  };
}

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    title: "Night Market", description: "Vendors", date: "2026-10-31", startTime: "19:00", endTime: "23:00",
    location: "123 Broadway, Manhattan", category: "street_fair", url: "https://example.com/event",
    temporalStatus: "scheduled_event", temporalEvidence: "October 31, 7pm to 11pm", ...overrides,
  };
}

function event(title: string): ScrapedEvent {
  return {
    title, description: "Vendors", ...parseEventTimes("2026-10-31", "19:00", "23:00"),
    location: "123 Broadway, Manhattan", category: "street_fair", sourceUrl: "https://example.com/event",
    sourceName: "test", temporalStatus: "scheduled_event", temporalEvidence: "October 31, 7pm to 11pm",
  };
}

const identity = (text: string) => text;

test("whole-item batches submit the tail instead of caching truncated input", async () => {
  const store = memoryStore();
  const cache = new ExtractionCache("test", { store });
  const items = ["a".repeat(60_000), "b".repeat(60_000), "tail"];
  const sent: string[] = [];
  const result = await parseNewItems(items, identity, cache, "https://example.com", "unused", {
    extract: async (text) => { sent.push(text); return [event(text.startsWith("a") ? "first" : "tail")]; },
  });
  assert.deepEqual(result.items, items);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], items[0]);
  assert.equal(sent[1], `${items[1]}\n\n---\n\ntail`);
  assert.ok(sent.every((text) => text.length <= MAX_EXTRACTION_CONTENT_CHARS));
  assert.equal(result.events.length, 2);
  assert.equal(await cache.commit(), 3);
  const retry = new ExtractionCache("test", { store });
  assert.deepEqual((await retry.filterNew(items, identity)).items, []);
});

test("batch limit includes separators and permits an exact-limit request", async () => {
  const cache = new ExtractionCache("test", { store: memoryStore() });
  const lengths: number[] = [];
  await parseNewItems(["a".repeat(49_996), "b".repeat(49_997)], identity, cache, "https://example.com", "unused", {
    extract: async (text) => { lengths.push(text.length); return []; },
  });
  assert.deepEqual(lengths, [100_000]);
});

test("an oversized individual item fails before any call or key staging", async () => {
  const store = memoryStore();
  const cache = new ExtractionCache("test", { store });
  let calls = 0;
  await assert.rejects(parseNewItems(["small", "x".repeat(100_001)], identity, cache, "https://example.com", "unused", {
    extract: async () => { calls++; return []; },
  }), /item exceeds the input limit/);
  assert.equal(calls, 0);
  assert.equal(await cache.commit(), 0);
  assert.equal(store.saved.size, 0);
});

test("a later batch failure propagates and stages none of the source items", async () => {
  const store = memoryStore();
  const cache = new ExtractionCache("test", { store });
  const items = ["a".repeat(60_000), "b".repeat(60_000)];
  let calls = 0;
  await assert.rejects(parseNewItems(items, identity, cache, "https://example.com", "unused", {
    extract: async () => { if (++calls === 2) throw new Error("model failed"); return [event("first")]; },
  }), /model failed/);
  assert.equal(calls, 2);
  assert.equal(await cache.commit(), 0);
  assert.deepEqual((await new ExtractionCache("test", { store }).filterNew(items, identity)).items, items);
});

test("invalid JSON and schema failures cannot turn into a cached successful zero", async () => {
  for (const response of ["not JSON", "{}", JSON.stringify([rawEvent({ temporalStatus: undefined })]), JSON.stringify([rawEvent({ temporalEvidence: "" })])]) {
    const store = memoryStore();
    const cache = new ExtractionCache("test", { store });
    await assert.rejects(parseNewItems(["card"], identity, cache, "https://example.com", "unused", {
      extract: async () => { parseExtractionResponse(response); return []; },
    }));
    assert.equal(await cache.commit(), 0);
    assert.equal(store.saved.size, 0);
  }
});

test("valid empty extraction is cached and avoids a second model call", async () => {
  const store = memoryStore();
  let calls = 0;
  const extract = async () => { calls++; return []; };
  const first = new ExtractionCache("test", { store });
  assert.deepEqual(await parseNewItems(["no events"], identity, first, "https://example.com", "unused", { extract }), { items: ["no events"], events: [] });
  await first.commit();
  const second = new ExtractionCache("test", { store });
  assert.deepEqual(await parseNewItems(["no events"], identity, second, "https://example.com", "unused", { extract }), { items: [], events: [] });
  assert.equal(calls, 1);
});

test("schema validation retains intentional permanent-attraction decisions", () => {
  const permanent = rawEvent({ temporalStatus: "permanent_attraction", temporalEvidence: "Ordinary daily admission", date: "", startTime: "", endTime: "", location: "" });
  assert.deepEqual(parseExtractionResponse(JSON.stringify([permanent])), [permanent]);
  assert.deepEqual(parseExtractionResponse("[]"), []);
  for (const overrides of [
    { date: "2026-02-30" }, { date: "" }, { startTime: "28:00" }, { endTime: "12:99" },
    { startTime: "24:30" }, { category: "museum" }, { location: 123 }, { url: 123 },
  ]) assert.throws(() => parseExtractionResponse(JSON.stringify([rawEvent(overrides)])));
});

test("parser uses real EST dates in early March and after November fallback", () => {
  for (const date of ["2026-03-01", "2026-11-15"]) {
    assert.equal(new Date(parseEventTimes(date, "10:00", "18:00").startTimestamp).toISOString(), `${date}T15:00:00.000Z`);
  }
});

test("parser converts overnight endpoints separately across DST changes", () => {
  const fall = parseEventTimes("2026-10-31", "23:00", "03:00");
  assert.equal(new Date(fall.startTimestamp).toISOString(), "2026-11-01T03:00:00.000Z");
  assert.equal(new Date(fall.endTimestamp).toISOString(), "2026-11-01T08:00:00.000Z");
  const spring = parseEventTimes("2026-03-07", "23:00", "03:00");
  assert.equal(new Date(spring.endTimestamp).toISOString(), "2026-03-08T07:00:00.000Z");
});

test("parser keeps unknown-time defaults and treats 24:00 as next-date midnight", () => {
  const defaults = parseEventTimes("2026-10-31", "", "");
  assert.equal(new Date(defaults.startTimestamp).toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(new Date(defaults.endTimestamp).toISOString(), "2026-11-01T03:59:00.000Z");
  const midnight = parseEventTimes("2026-10-31", "19:00", "24:00");
  assert.equal(new Date(midnight.endTimestamp).toISOString(), "2026-11-01T04:00:00.000Z");
  const startsAtMidnight = parseEventTimes("2026-10-31", "24:00", "01:00");
  assert.equal(new Date(startsAtMidnight.endTimestamp).toISOString(), "2026-11-01T05:00:00.000Z");
});

test("spring-transition evening event chooses the next end date before checking the DST gap", () => {
  const overnight = parseEventTimes("2026-03-08", "22:00", "02:30");
  assert.equal(new Date(overnight.startTimestamp).toISOString(), "2026-03-09T02:00:00.000Z");
  assert.equal(new Date(overnight.endTimestamp).toISOString(), "2026-03-09T06:30:00.000Z");
});

test("overnight calendar selection keeps real DST gaps invalid and explicit-midnight conventions", () => {
  assert.throws(() => parseEventTimes("2026-03-07", "22:00", "02:30"), /does not exist/);
  assert.throws(() => parseEventTimes("2026-03-08", "02:30", "04:00"), /does not exist/);
  const equalMidnight = parseEventTimes("2026-10-31", "24:00", "24:00");
  assert.equal(new Date(equalMidnight.startTimestamp).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(new Date(equalMidnight.endTimestamp).toISOString(), "2026-11-02T05:00:00.000Z");
});
