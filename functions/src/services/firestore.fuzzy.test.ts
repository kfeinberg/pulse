import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { Timestamp } from "firebase-admin/firestore";
import type { ScrapedEvent } from "../scrapers/base.js";
import { findFuzzyDuplicate, type DuplicateCandidate } from "./firestore.js";

const event: ScrapedEvent = {
  title: "Smorgasburg WTC", description: "Food market", location: "World Trade Center", category: "happening",
  startTimestamp: Date.parse("2026-11-21T16:00:00Z"), endTimestamp: Date.parse("2026-11-21T22:00:00Z"),
  sourceUrl: "https://example.com/smorgasburg", sourceName: "test", temporalStatus: "scheduled_event", temporalEvidence: "Saturday",
};
const candidates: DuplicateCandidate[] = [
  { id: "williamsburg", title: "Smorgasburg Williamsburg", location: "Marsha P. Johnson State Park", startTime: Timestamp.fromMillis(event.startTimestamp) },
  { id: "wtc", title: "Smorgasburg World Trade Center", location: "WTC", startTime: Timestamp.fromMillis(event.startTimestamp) },
];

function toolClient(input: unknown, seen: Record<string, unknown>[] = []) {
  return {
    messages: {
      create: async (params: Record<string, unknown>) => {
        seen.push(params);
        return { content: [{ type: "tool_use", id: "toolu_1", name: "report_duplicate", input }], stop_reason: "tool_use" };
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
}

test("duplicate matching forces a tool answer limited to none or a candidate number", async () => {
  const seen: Record<string, unknown>[] = [];
  assert.equal(await findFuzzyDuplicate(event, new Date(event.startTimestamp), candidates, "unused", { client: toolClient({ match: "1" }, seen) }), "wtc");
  const params = seen[0] as { tool_choice: unknown; tools: Array<{ input_schema: { properties: { match: { enum: string[] } } } }> };
  assert.deepEqual(params.tool_choice, { type: "tool", name: "report_duplicate" });
  assert.deepEqual(params.tools[0].input_schema.properties.match.enum, ["none", "0", "1"]);
  assert.equal(await findFuzzyDuplicate(event, new Date(event.startTimestamp), candidates, "unused", { client: toolClient({ match: "none" }) }), null);
});

test("an out-of-range or malformed tool answer is still rejected, never guessed", async () => {
  for (const input of [{ match: "2" }, { match: "None." }, { match: 1 }, {}]) {
    await assert.rejects(findFuzzyDuplicate(event, new Date(event.startTimestamp), candidates, "unused", { client: toolClient(input) }), /Invalid duplicate-matching response/);
  }
  const textOnly = { messages: { create: async () => ({ content: [{ type: "text", text: "0" }], stop_reason: "end_turn" }) } } as unknown as Pick<Anthropic, "messages">;
  await assert.rejects(findFuzzyDuplicate(event, new Date(event.startTimestamp), candidates, "unused", { client: textOnly }), /did not return a report_duplicate tool call/);
});

test("no candidates means no model call", async () => {
  const client = { messages: { create: async () => { throw new Error("must not call"); } } } as unknown as Pick<Anthropic, "messages">;
  assert.equal(await findFuzzyDuplicate(event, new Date(event.startTimestamp), [], "unused", { client }), null);
});
