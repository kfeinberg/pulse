import assert from "node:assert/strict";
import test from "node:test";
import {
  isTemporalEvent,
  temporalExclusionReason,
} from "./temporalFilter.js";

test("rejects permanent attractions even when they have dated ticket slots", () => {
  const colorFactory = {
    title: "Color Factory New York",
    temporalStatus: "permanent_attraction",
    temporalEvidence: "General admission tickets are available today from 10am to 8pm",
  };

  assert.equal(isTemporalEvent(colorFactory), false);
  assert.match(temporalExclusionReason(colorFactory) ?? "", /permanent attraction/);
});

test("keeps discrete recurring occurrences", () => {
  assert.equal(
    isTemporalEvent({
      title: "Thursday Trivia",
      temporalStatus: "scheduled_event",
      temporalEvidence: "Weekly trivia every Thursday at 7pm",
    }),
    true
  );
});

test("keeps temporary multi-day events with source evidence", () => {
  assert.equal(
    isTemporalEvent({
      title: "Three-Day Art Fair",
      temporalStatus: "limited_run",
      temporalEvidence: "Runs October 9 through October 11",
    }),
    true
  );
});

test("fails closed when temporal classification is missing or unsupported", () => {
  assert.equal(
    isTemporalEvent({
      title: "Undated attraction",
      temporalEvidence: "Open today",
    }),
    false
  );
  assert.equal(
    isTemporalEvent({
      title: "Unknown attraction",
      temporalStatus: "unclear",
      temporalEvidence: "Open today",
    }),
    false
  );
});

test("fails closed when a temporal classification has no evidence", () => {
  assert.equal(
    isTemporalEvent({
      title: "Claimed pop-up",
      temporalStatus: "limited_run",
      temporalEvidence: "   ",
    }),
    false
  );
});
