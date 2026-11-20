import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ScrapedEvent } from "../scrapers/base.js";
import { ExtractionCache, type SeenItemStore } from "./extractionCache.js";
import {
  extractEvents, normalizeCategory, parseEventTimes, parseExtractionResponse, parseNewItems,
  partitionExtractionResponse, type ExtractionReport,
} from "./parser.js";

function raw(overrides: Record<string, unknown> = {}) {
  return {
    title: "Night Market", description: "Vendors", date: "2026-10-31", endDate: "2026-10-31",
    startTime: "19:00", endTime: "23:00", location: "123 Broadway, Manhattan", category: "street_fair",
    url: "https://example.com/night-market", temporalStatus: "scheduled_event", temporalEvidence: "October 31, 7pm to 11pm",
    ...overrides,
  };
}

// Streams the scripted replies in order (repeating the last one).
function scriptedClient(replies: string[]): { client: Anthropic; calls: () => number } {
  let calls = 0;
  const client = {
    messages: {
      create: () => { throw new Error("extraction must stream"); },
      stream: () => {
        const text = replies[Math.min(calls++, replies.length - 1)];
        return { finalMessage: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => calls };
}

function recorder(): ExtractionReport & { reasons: string[] } {
  const reasons: string[] = [];
  return { reasons, partial: (reason) => { reasons.push(reason); } };
}

function memoryStore(): SeenItemStore {
  const saved = new Set<string>();
  return {
    async findExisting(keys) { return new Set(keys.filter((key) => saved.has(key))); },
    async save(keys) { keys.forEach((key) => saved.add(key)); },
  };
}

function event(title: string): ScrapedEvent {
  return {
    title, description: "Vendors", ...parseEventTimes("2026-10-31", "19:00", "23:00"),
    location: "123 Broadway, Manhattan", category: "street_fair", sourceUrl: "https://example.com/event",
    sourceName: "test", temporalStatus: "scheduled_event", temporalEvidence: "October 31, 7pm to 11pm",
  };
}

test("category labels normalize to canonical values, and unknown labels are not invented", () => {
  assert.equal(normalizeCategory("Pop-Up"), "popup");
  assert.equal(normalizeCategory("pop up"), "popup");
  assert.equal(normalizeCategory("Farmer's Market"), "farmers_market");
  assert.equal(normalizeCategory("Free Stuff"), "free_stuff");
  assert.equal(normalizeCategory("concert"), "concerts");
  assert.equal(normalizeCategory("Trick-or-Treat"), "trick_or_treat");
  assert.equal(normalizeCategory("museum"), null);
  assert.equal(normalizeCategory(7), null);
});

test("partitioning keeps strict per-candidate validation but isolates each malformed candidate", () => {
  const response = JSON.stringify([
    raw(),
    raw({ title: "Comedy Night", category: "Comedy" }),
    raw({ title: "Bad date", date: "2026-02-30" }),
    raw({ title: "Bad status", temporalStatus: "forever" }),
    raw({ title: "Popup", category: "Pop-Up" }),
  ]);
  const { events, rejected } = partitionExtractionResponse(response);
  assert.deepEqual(events.map((e) => [e.title, e.category]), [["Night Market", "street_fair"], ["Comedy Night", "happening"], ["Popup", "popup"]]);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0], /Invalid extraction date/);
  assert.match(rejected[1], /invalid temporalStatus/);
  // The whole-response contract is unchanged: it must be a JSON array.
  assert.throws(() => partitionExtractionResponse("not JSON"), /Failed to parse/);
  assert.throws(() => partitionExtractionResponse("{}"), /not an array/);
  // The strict single-shot validator still rejects unknown labels outright.
  assert.throws(() => parseExtractionResponse(JSON.stringify([raw({ category: "Comedy" })])), /invalid category/);
});

test("an unknown category label falls back to the catch-all without a second model call", async () => {
  const { client, calls } = scriptedClient([JSON.stringify([raw({ category: "Comedy" })])]);
  const report = recorder();
  const events = await extractEvents("page", "test", "https://example.com", "unused", { client, report });
  assert.equal(events[0].category, "happening");
  assert.equal(calls(), 1);
  assert.deepEqual(report.reasons, []);
});

test("a malformed response gets one fresh attempt, and a clean retry is not partial", async () => {
  const { client, calls } = scriptedClient([
    JSON.stringify([raw(), raw({ title: "Broken", startTime: "28:00" })]),
    JSON.stringify([raw(), raw({ title: "Fixed" })]),
  ]);
  const report = recorder();
  const events = await extractEvents("page", "test", "https://example.com", "unused", { client, report });
  assert.equal(calls(), 2);
  assert.deepEqual(events.map((e) => e.title), ["Night Market", "Fixed"]);
  assert.deepEqual(report.reasons, []);
});

test("a candidate that stays malformed is reported while its valid siblings are delivered", async () => {
  const replies = [JSON.stringify([raw(), raw({ title: "Broken", location: "" })])];
  const report = recorder();
  const events = await extractEvents("page", "test", "https://example.com", "unused", { client: scriptedClient(replies).client, report });
  assert.deepEqual(events.map((e) => e.title), ["Night Market"]);
  assert.equal(report.reasons.length, 1);
  assert.match(report.reasons[0], /missing location/);
  // Without a report the partial result cannot be recorded, so it fails closed.
  await assert.rejects(extractEvents("page", "test", "https://example.com", "unused", { client: scriptedClient(replies).client }), /missing location/);
});

test("invalid JSON twice still fails the batch", async () => {
  const { client, calls } = scriptedClient(["[{partial"]);
  await assert.rejects(extractEvents("page", "test", "https://example.com", "unused", { client, report: recorder() }), /Failed to parse extraction JSON/);
  assert.equal(calls(), 2);
});

test("a failed Eventbrite lookup keeps the event with the listing link and marks the batch partial", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Method Not Allowed", { status: 405 })) as typeof fetch;
  try {
    const { client } = scriptedClient([JSON.stringify([raw({ url: "https://www.eventbrite.com/e/night-market" }), raw({ title: "Other" })])]);
    const report = recorder();
    const events = await extractEvents("page", "test", "https://example.com/listing", "unused", { client, report });
    assert.deepEqual(events.map((e) => e.sourceUrl), ["https://example.com/listing", "https://example.com/night-market"]);
    assert.equal(report.reasons.length, 1);
    assert.match(report.reasons[0], /Eventbrite URL resolution failed/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a partial batch delivers its events but leaves only its own items unstaged", async () => {
  const store = memoryStore();
  const cache = new ExtractionCache("test", { store });
  const items = ["a".repeat(60_000), "b".repeat(60_000)];
  const result = await parseNewItems(items, (text) => text, cache, "https://example.com", "unused", {
    extract: async (text, _name, _url, _key, report) => {
      if (text.startsWith("a")) report?.partial("one candidate was malformed");
      return [event(text.slice(0, 1))];
    },
  });
  assert.deepEqual(result.events.map((e) => e.title), ["a", "b"]);
  assert.equal(cache.stagedKeys.length, 1);
  assert.equal(cache.failureReasons.length, 1);
  assert.match(cache.failureReasons[0], /1 item\(s\) will be extracted again: one candidate was malformed/);
  await cache.commit();
  const next = new ExtractionCache("test", { store });
  assert.deepEqual((await next.filterNew(items, (text) => text)).items, [items[0]]);
});

test("vague locations resolve through a forced tool call, and a failed lookup holds back only that event", async () => {
  const extraction = JSON.stringify([raw({ title: "Chain Giveaway", location: "Multiple locations" }), raw()]);
  const client = (create: () => Promise<unknown>) => ({
    messages: {
      create,
      stream: () => ({ finalMessage: async () => ({ content: [{ type: "text", text: extraction }], stop_reason: "end_turn" }) }),
    },
  }) as unknown as Anthropic;
  const report = recorder();
  const resolved = await extractEvents("page", "test", "https://example.com", "unused", {
    report,
    client: client(async () => ({ content: [{ type: "tool_use", id: "t", name: "report_locations", input: { locations: ["Shop, 1 Main St, Brooklyn, NY", "Shop, 2 Main St, Queens, NY"] } }], stop_reason: "tool_use" })),
  });
  assert.deepEqual(resolved.map((e) => e.location).sort(), ["123 Broadway, Manhattan", "Shop, 1 Main St, Brooklyn, NY", "Shop, 2 Main St, Queens, NY"]);
  assert.deepEqual(report.reasons, []);
  const failing = recorder();
  const partial = await extractEvents("page", "test", "https://example.com", "unused", {
    report: failing,
    client: client(async () => ({ content: [{ type: "text", text: "I think there are a few" }], stop_reason: "end_turn" })),
  });
  assert.deepEqual(partial.map((e) => e.title), ["Night Market"]);
  assert.match(failing.reasons[0], /Location resolution failed for "Chain Giveaway"/);
});
