import assert from "node:assert/strict";
import test from "node:test";

import {
  addDays,
  etDateParts,
  etTimestamp,
  etWeekday,
  formatUsDate,
} from "./etTime.js";

test("etTimestamp uses EDT (UTC-4) in October", () => {
  assert.equal(
    new Date(etTimestamp(2026, 10, 14, 10, 0)).toISOString(),
    "2026-10-14T14:00:00.000Z"
  );
});

test("etTimestamp uses EST (UTC-5) after the November DST transition", () => {
  assert.equal(
    new Date(etTimestamp(2026, 11, 15, 10, 0)).toISOString(),
    "2026-11-15T15:00:00.000Z"
  );
});

test("etTimestamp handles late-night end times", () => {
  assert.equal(
    new Date(etTimestamp(2026, 10, 31, 23, 59)).toISOString(),
    "2026-11-01T03:59:00.000Z"
  );
});

test("etDateParts and etWeekday report the ET calendar day", () => {
  // 2026-10-14T03:30Z is still Tuesday Oct 13 in New York.
  const ms = Date.parse("2026-10-14T03:30:00.000Z");
  assert.deepEqual(etDateParts(ms), { year: 2026, month: 10, day: 13 });
  assert.equal(etWeekday(ms), "Tuesday");
});

test("addDays and formatUsDate roll over month boundaries", () => {
  assert.equal(formatUsDate(addDays({ year: 2026, month: 10, day: 31 }, 2)), "11/02/2026");
});
