import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { Response as NodeResponse } from "node-fetch";
import { extractEvents, parseNewItems } from "./parser.js";
import { ExtractionCache, type SeenItemStore } from "./extractionCache.js";

const item = {
  title: "Temporary Exhibition", description: "A limited exhibition", date: "2026-11-13", endDate: "2027-02-21",
  startTime: "10:00", endTime: "18:00", location: "89 East 42nd Street, Manhattan", category: "happening",
  url: "https://example.com/exhibition", temporalStatus: "limited_run", temporalEvidence: "November 13 through February 21",
};
const text = JSON.stringify([item]);
const message = (stop_reason: string | null = "end_turn", content = text) => ({ content: [{ type: "text", text: content }], stop_reason });
function fakeClient(reply: ReturnType<typeof message> | Error): Anthropic {
  return { messages: {
    create: () => { throw Error("Extraction must use streaming, not a long idle request"); },
    stream: (params: { model: string; max_tokens: number }) => {
      assert.equal(params.model, "claude-haiku-4-5-20251001");
      assert.equal(params.max_tokens, 32768);
      return { finalMessage: async () => { if (reply instanceof Error) throw reply; return reply; } };
    },
  } } as unknown as Anthropic;
}
function cache() {
  const saved = new Set<string>();
  const store: SeenItemStore = { findExisting: async () => new Set(), save: async (keys) => { keys.forEach((key) => saved.add(key)); } };
  return { cache: new ExtractionCache("nycforfree", { store }), saved };
}

test("extraction consumes a fully aggregated stream and preserves a limited run's final date", async () => {
  const result = await extractEvents("source card", "nycforfree", item.url, "unused", { client: fakeClient(message()) });
  assert.equal(result.length, 1);
  assert.equal(result[0].endTimestamp, Date.parse("2027-02-21T23:00:00Z"));
});

test("real SDK SSE text deltas aggregate into the same validated JSON event", async () => {
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const midpoint = Math.floor(text.length / 2);
  const body = [
    event("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, midpoint) } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(midpoint) } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  const client = new Anthropic({ apiKey: "unused", fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new NodeResponse(body, { headers: { "Content-Type": "text/event-stream" } });
  } });
  const result = await extractEvents("source card", "nycforfree", item.url, "unused", { client });
  assert.equal(result[0].title, item.title);
  assert.equal(result[0].endTimestamp, Date.parse("2027-02-21T23:00:00Z"));
});

for (const [name, reply] of [
  ["connection interruption", new Error("stream disconnected")],
  ["missing terminal stop reason", message(null)],
  ["output token truncation", message("max_tokens")],
  ["malformed final JSON", message("end_turn", "[{partial")],
] as const) {
  test(`${name} cannot stage a source cache key`, async () => {
    const state = cache();
    await assert.rejects(parseNewItems(["card"], (source) => source, state.cache, item.url, "unused", {
      extract: (content, name, url, key) => extractEvents(content, name, url, key, { client: fakeClient(reply) }),
    }));
    assert.deepEqual(state.cache.stagedKeys, []);
    await state.cache.commit();
    assert.equal(state.saved.size, 0);
  });
}
