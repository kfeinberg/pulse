import assert from "node:assert/strict";
import test from "node:test";
import { fetchUpcomingShows } from "./ohmyrockness.js";

const now = Date.parse("2026-10-16T12:00:00Z");

test("OhMyRockness propagates a later-page failure instead of successful partial results", async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes("/api/shows.json")) return new Response("no bundle", { status: 200 });
    const page = new URL(url).searchParams.get("page");
    if (page === "1") return Response.json([{ id: 1, starts_at: "2026-10-16T19:00:00-04:00" }]);
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(fetchUpcomingShows(now, request), /page 2 failed: 503/);
  assert.equal(calls.filter((url) => url.includes("/api/shows.json")).length, 2);
});

test("OhMyRockness rejects malformed page schema instead of treating it as end of listing", async () => {
  const request: typeof fetch = async (input) => String(input).includes("/api/shows.json")
    ? Response.json({ error: "service unavailable" }) : new Response("no bundle");
  await assert.rejects(fetchUpcomingShows(now, request), /page 1 was not an array/);
});

test("OhMyRockness still accepts a genuine empty final page", async () => {
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (!url.includes("/api/shows.json")) return new Response("no bundle");
    return Response.json(new URL(url).searchParams.get("page") === "1"
      ? [{ id: 1, starts_at: "2026-10-16T19:00:00-04:00" }] : []);
  };
  assert.deepEqual((await fetchUpcomingShows(now, request)).map((show) => show.id), [1]);
});
