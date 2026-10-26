import assert from "node:assert/strict";
import test from "node:test";
import { resolveEventbriteUrl } from "./eventUrl.js";

test("Eventbrite retrieval failures are not cached as missing event URLs", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    if (calls === 1) return new Response("temporary", { status: 503 });
    return new Response('<a href="https://www.eventbrite.com/e/pulse-test-night-market-tickets-123456">market</a>');
  };
  const args = ["Pulse Test Night Market", "https://www.eventbrite.com/e/pulse-test-night-market"] as const;
  await assert.rejects(resolveEventbriteUrl(...args, { fetch: fakeFetch }), /resolution failed/);
  assert.equal(await resolveEventbriteUrl(...args, { fetch: fakeFetch }), "https://www.eventbrite.com/e/pulse-test-night-market-tickets-123456");
  assert.equal(calls, 2);
});

test("successfully retrieved empty Eventbrite results are a cacheable negative", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response("<html>No events</html>"); };
  for (let i = 0; i < 2; i++) assert.equal(await resolveEventbriteUrl("Unique Empty Fixture", "https://www.eventbrite.com/e/unique-empty-fixture", { fetch: fakeFetch }), null);
  assert.equal(calls, 1);
});
