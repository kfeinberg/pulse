import assert from "node:assert/strict";
import test from "node:test";
import { parseDateAndTime } from "./trickorstreets.js";

test("Trick-or-Streets overnight rollover uses the next ET date across fall DST", () => {
  const times = parseDateAndTime("Saturday, October 31, 2026", "11 PM to 3 AM");
  assert.ok(times);
  assert.equal(new Date(times.startTimestamp).toISOString(), "2026-11-01T03:00:00.000Z");
  assert.equal(new Date(times.endTimestamp).toISOString(), "2026-11-01T08:00:00.000Z");
});

test("Trick-or-Streets overnight rollover also handles spring DST", () => {
  const times = parseDateAndTime("Saturday, March 7, 2026", "11 PM to 3 AM");
  assert.ok(times);
  assert.equal(new Date(times.endTimestamp).toISOString(), "2026-03-08T07:00:00.000Z");
});
