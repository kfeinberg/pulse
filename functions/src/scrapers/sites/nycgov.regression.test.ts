import assert from "node:assert/strict";
import test from "node:test";
import type { ScrapedEvent } from "../base.js";
import { detailUrl, forcedCategory, overlayNycGovEvents, type NycGovEventItem } from "./nycgov.js";

function item(id: number, overrides: Partial<NycGovEventItem> = {}): NycGovEventItem {
  return {
    id, sequence: 1, name: `Annual Neighborhood Festival ${id}`, shortDesc: "Single Block Festival",
    startDate: `2026-10-31T${id === 1 ? "10" : "14"}:00:00-04:00`,
    endDate: `2026-10-31T${id === 1 ? "12" : "18"}:00:00-04:00`,
    permalink: `https://www1.nyc.gov/events/festival-${id}/${id}/1`,
    address: `${id === 1 ? "123" : "456"} BROADWAY Manhattan`, boroughs: ["Mn"], ...overrides,
  };
}

function parsed(source: NycGovEventItem, category: ScrapedEvent["category"] = "happening"): ScrapedEvent {
  return {
    title: source.name, description: "Festival", startTimestamp: 0, endTimestamp: 1, location: "Model location",
    category, sourceUrl: detailUrl(source), sourceName: "nycgov", temporalStatus: "scheduled_event",
    temporalEvidence: "October 31 festival",
  };
}

const now = Date.parse("2026-10-30T12:00:00Z");

test("NYC.gov overlays source identity, not first matching 25-character title prefix", () => {
  const a = item(1);
  const b = item(2);
  assert.equal(a.name.slice(0, 25), b.name.slice(0, 25));
  const result = overlayNycGovEvents([parsed(b), parsed(a)], [a, b], now);
  assert.deepEqual(result.map((event) => event.sourceUrl), [detailUrl(b), detailUrl(a)]);
  assert.deepEqual(result.map((event) => event.startTimestamp), [Date.parse(b.startDate), Date.parse(a.startDate)]);
  assert.deepEqual(result.map((event) => event.location), ["456 Broadway, Manhattan", "123 Broadway, Manhattan"]);
});

test("NYC.gov matches reordered detail query parameters using id and sequence", () => {
  const source = item(2);
  const event = parsed(source);
  event.sourceUrl = "https://www.nyc.gov/main/events/?sequence=1&id=2&permalinkName=festival-2";
  event.title = "Model-renamed festival";
  assert.equal(overlayNycGovEvents([event], [source], now)[0].startTimestamp, Date.parse(source.startDate));
});

test("ambiguous or unmatched NYC.gov output fails instead of being silently cached", () => {
  const a = item(1, { name: "Festival" });
  const b = item(2, { name: "Festival" });
  const event = parsed(a);
  event.sourceUrl = "https://www.nyc.gov/main/events/";
  assert.throws(() => overlayNycGovEvents([event], [a, b], now), /ambiguous/);
  event.title = "Unknown event";
  assert.throws(() => overlayNycGovEvents([event], [a, b], now), /Unmatched/);
});

test("Halloween trick-or-treat block parties retain their specific category", () => {
  const explicit = item(1, { name: "Halloween Trick-or-Treat Block Party" });
  assert.equal(forcedCategory(explicit), "trick_or_treat");
  const inferred = item(2, { name: "Neighborhood Halloween Celebration" });
  assert.equal(forcedCategory(inferred), "street_fair");
  assert.equal(overlayNycGovEvents([parsed(inferred, "trick_or_treat")], [inferred], now)[0].category, "trick_or_treat");
  const market = item(1, { name: "Halloween Greenmarket", shortDesc: "Farmers Market" });
  assert.equal(forcedCategory(market), "farmers_market");
});
