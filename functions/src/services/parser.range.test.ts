import assert from "node:assert/strict";
import test from "node:test";
import { parseEventTimes, parseExtractionResponse } from "./parser.js";
import { EXTRACTION_PROMPT } from "./extractionPrompt.js";

const extracted = {
  title: "Holiday Train Show", description: "Temporary train exhibition", date: "2026-11-13",
  endDate: "2027-02-21", startTime: "10:00", endTime: "19:00",
  location: "Grand Central Gallery, 89 East 42nd Street, Manhattan", category: "happening",
  url: "https://www.nycforfree.co/events/holiday-train-show", temporalStatus: "limited_run",
  temporalEvidence: "November 13 through February 21",
};

test("continuous Holiday Train Show retains the final date rather than opening-night expiry", () => {
  const range = parseEventTimes(extracted.date, extracted.startTime, extracted.endTime, extracted.endDate);
  assert.equal(range.startTimestamp, Date.parse("2026-11-13T15:00:00Z"));
  assert.equal(range.endTimestamp, Date.parse("2027-02-22T00:00:00Z"));
  for (const now of ["2026-11-14T18:00:00Z", "2026-12-25T18:00:00Z", "2027-02-21T23:59:59Z"]) {
    assert.ok(range.startTimestamp <= Date.parse(now) && range.endTimestamp > Date.parse(now));
  }
  assert.ok(range.endTimestamp <= Date.parse("2027-02-22T00:00:00Z"));
});

test("weekend popup remains active on its second and final days", () => {
  const range = parseEventTimes("2026-11-13", "11:00", "18:00", "2026-11-15");
  assert.equal(range.endTimestamp, Date.parse("2026-11-15T23:00:00Z"));
  assert.ok(range.endTimestamp > Date.parse("2026-11-14T20:00:00Z"));
});

test("each endpoint of a continuous range uses the correct DST offset", () => {
  const range = parseEventTimes("2026-10-31", "10:00", "18:00", "2026-11-02");
  assert.equal(range.startTimestamp, Date.parse("2026-10-31T14:00:00Z"));
  assert.equal(range.endTimestamp, Date.parse("2026-11-02T23:00:00Z"));
});

test("endDate preserves legacy overnight and explicit midnight semantics", () => {
  assert.deepEqual(parseEventTimes("2026-11-13", "22:00", "02:00"), {
    startTimestamp: Date.parse("2026-11-14T03:00:00Z"), endTimestamp: Date.parse("2026-11-14T07:00:00Z"),
  });
  assert.deepEqual(parseEventTimes("2026-11-13", "22:00", "02:00", "2026-11-14"), {
    startTimestamp: Date.parse("2026-11-14T03:00:00Z"), endTimestamp: Date.parse("2026-11-14T07:00:00Z"),
  });
  assert.equal(parseEventTimes("2026-11-13", "10:00", "24:00", "2026-11-15").endTimestamp,
    Date.parse("2026-11-16T05:00:00Z"));
});

test("malformed and inverted final dates cannot silently become a one-day event", () => {
  for (const endDate of ["2026-02-30", "tomorrow", "2026-11-12"]) {
    assert.throws(() => parseEventTimes("2026-11-13", "10:00", "19:00", endDate));
    assert.throws(() => parseExtractionResponse(JSON.stringify([{ ...extracted, endDate }])));
  }
  assert.throws(() => parseExtractionResponse(JSON.stringify([{ ...extracted, endDate: 123 }])));
});

test("extraction schema preserves endDate and remains compatible with older single-day responses", () => {
  assert.equal(parseExtractionResponse(JSON.stringify([extracted]))[0].endDate, "2027-02-21");
  const { endDate: _endDate, ...legacy } = extracted;
  assert.equal(parseExtractionResponse(JSON.stringify([{ ...legacy, temporalStatus: "scheduled_event" }]))[0].endDate, undefined);
  assert.throws(() => parseExtractionResponse(JSON.stringify([legacy])), /missing its final date/);
  assert.throws(() => parseExtractionResponse(JSON.stringify([{ ...legacy, endDate: "" }])), /missing its final date/);
  assert.match(EXTRACTION_PROMPT, /"endDate"/);
  assert.match(EXTRACTION_PROMPT, /first day is in the past/);
});
