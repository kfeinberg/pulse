import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidatePdfUrls,
  extractSchedulePdfUrl,
  normalizeFairLocation,
  parseStreetFairSchedule,
} from "./nycstreetfairs.js";

// Text as extracted from the live 8th-edition 2026 schedule PDF.
const SCHEDULE_TEXT = `CODE # DAY DATE FESTIVAL & LOCATION
74 THURSDAY OCT. 1ˢᵗ FINANCIAL COMMUNITY FAIR
(ON PARK PLACE from BROADWAY - CHURCH ST.)
75 SATURDAY OCT. 3rd
TIMES SQUARE EXPO
(ON 7ᵗʰ AVENUE from 47ᵗʰ - 57ᵗʰ ST.)
76 SUNDAY OCT. 4ᵗʰ LEXINGTON AVENUE FOOD FAIR
(ON LEXINGTON AVENUE from 51ˢᵗ - 57ᵗʰ ST.
L19 WEDNESDAY OCT. 7th
LIBERTY PARK FAIR
(ON LIBERTY ST. SIDEWALK from BROADWAY - TRINITY PL.)
88 SATURDAY OCT. 31ˢᵗ BROADWAY FALL FAIR
(ON BROADWAY from 8ᵗʰ - 14ᵗʰ ST.)
89 WEDNESDAY NOV. 4ᵗʰ FULTON MALL/METRO TECH SERIES FAIR
*BROOKLYN* (ON LAWRENCE ST. from FULTON - WILLOUGHBY ST.)
225 Broadway, Suite 1202
New York, NY 10007
2026 EVENT SCHEDULE
ALL EVENTS WILL BE HELD RAIN OR SHINE FROM 10AM TO 6PM`;

const SEP_30_2026 = Date.parse("2026-09-30T12:00:00.000Z");

test("extractSchedulePdfUrl reads the WonderPlugin iframe file parameter", () => {
  const html = `<iframe class="wonderplugin-pdf-iframe" src="https://nycstreetfairs.com/wp-content/plugins/wonderplugin-pdf-embed/pdfjslight/web/viewer.html?v=2&file=https://nycstreetfairs.com/wp-content/uploads/2026/10/2026-Vendor-Schedule-8TH-EDITION.pdf">`;
  assert.equal(
    extractSchedulePdfUrl(html),
    "https://nycstreetfairs.com/wp-content/uploads/2026/10/2026-Vendor-Schedule-8TH-EDITION.pdf"
  );
});

test("extractSchedulePdfUrl falls back to a schedule link and skips other PDFs", () => {
  const html =
    `<a href="https://nycstreetfairs.com/wp-content/uploads/2024/08/2024-price-list.pdf">Price list</a>` +
    `<a href="https://nycstreetfairs.com/wp-content/uploads/2027/03/2027-Vendor-Schedule.pdf">DOWNLOAD/PRINT SCHEDULE</a>`;
  assert.equal(
    extractSchedulePdfUrl(html),
    "https://nycstreetfairs.com/wp-content/uploads/2027/03/2027-Vendor-Schedule.pdf"
  );
  assert.equal(extractSchedulePdfUrl("<p>No PDFs here</p>"), null);
});

test("buildCandidatePdfUrls probes newest month and edition first, across year boundaries", () => {
  const urls = buildCandidatePdfUrls(Date.parse("2026-10-14T12:00:00.000Z"));
  assert.equal(
    urls[0],
    "https://nycstreetfairs.com/wp-content/uploads/2026/10/2026-Vendor-Schedule-12TH-EDITION.pdf"
  );
  assert.ok(
    urls.includes(
      "https://nycstreetfairs.com/wp-content/uploads/2026/10/2026-Vendor-Schedule-8TH-EDITION.pdf"
    )
  );
  assert.ok(
    urls.includes("https://nycstreetfairs.com/wp-content/uploads/2026/10/2026-Vendor-Schedule-3RD-EDITION.pdf")
  );
  const january = buildCandidatePdfUrls(Date.parse("2027-01-10T12:00:00.000Z"));
  assert.ok(
    january.some((u) => u.includes("/uploads/2026/11/2026-Vendor-Schedule")),
    "January probes should reach back into the prior year's folders"
  );
});

test("parseStreetFairSchedule parses capped rows, ordinals, L-codes, and borough markers", () => {
  const events = parseStreetFairSchedule(SCHEDULE_TEXT, SEP_30_2026);
  assert.equal(events.length, 6);

  const timesSquare = events.find((e) => e.title === "Times Square Expo");
  assert.ok(timesSquare);
  assert.equal(timesSquare.category, "street_fair");
  assert.equal(timesSquare.temporalStatus, "scheduled_event");
  assert.equal(
    timesSquare.location,
    "7th Avenue between West 47th Street and West 57th Street, Manhattan"
  );
  // Oct 3, 2026 10:00 EDT = 14:00 UTC; ends 18:00 EDT = 22:00 UTC.
  assert.equal(new Date(timesSquare.startTimestamp).toISOString(), "2026-10-03T14:00:00.000Z");
  assert.equal(new Date(timesSquare.endTimestamp).toISOString(), "2026-10-03T22:00:00.000Z");
  assert.match(timesSquare.temporalEvidence, /Saturday, October 3/);

  const lexington = events.find((e) => e.title === "Lexington Avenue Food Fair");
  assert.equal(
    lexington?.location,
    "Lexington Avenue between East 51st Street and East 57th Street, Manhattan"
  );

  const liberty = events.find((e) => e.title === "Liberty Park Fair");
  assert.equal(liberty?.location, "Liberty Street between Broadway and Trinity Place, Manhattan");

  const brooklyn = events.find((e) => e.title === "Fulton Mall/metro Tech Series Fair");
  assert.equal(brooklyn?.location, "Lawrence Street between Fulton and Willoughby Street, Brooklyn");
  // Nov 4 is after the DST transition: 10:00 EST = 15:00 UTC.
  assert.equal(new Date(brooklyn!.startTimestamp).toISOString(), "2026-11-04T15:00:00.000Z");
});

test("parseStreetFairSchedule drops fairs that have already ended", () => {
  const events = parseStreetFairSchedule(SCHEDULE_TEXT, Date.parse("2026-10-20T12:00:00.000Z"));
  assert.deepEqual(
    events.map((e) => e.title),
    ["Broadway Fall Fair", "Fulton Mall/metro Tech Series Fair"]
  );
});

test("parseStreetFairSchedule handles en-dash ranges and trailing periods", () => {
  const text = `86 SUNDAY OCT. 25ᵗʰ BRYANT PARK AUTUMN FAIR
(ON 41ˢᵗ STREET from 6ᵗʰ AVE. - BROADWAY.)
72 SUNDAY OCT. 25ᵗʰ 6ᵗʰ AVENUE AUTUMN FAIR
(ON 6ᵗʰ AVE from 14ᵗʰ – 20ᵗʰ STREET.)
2026 EVENT SCHEDULE
ALL EVENTS WILL BE HELD RAIN OR SHINE FROM 10AM TO 6PM`;
  const events = parseStreetFairSchedule(text, SEP_30_2026);
  assert.equal(events.length, 2);
  assert.equal(
    events[0].location,
    "41st Street between 6th Avenue and Broadway, Manhattan"
  );
  assert.equal(
    events[1].location,
    "6th Avenue between West 14th Street and West 20th Street, Manhattan"
  );
});

test("normalizeFairLocation shares the second cross street's suffix", () => {
  assert.equal(
    normalizeFairLocation("6th AVENUE from 34th - 42nd ST.", "Manhattan"),
    "6th Avenue between West 34th Street and West 42nd Street, Manhattan"
  );
  assert.equal(
    normalizeFairLocation("50th STREET from 6th - 7th AVE.", "Manhattan"),
    "50th Street between 6th Avenue and 7th Avenue, Manhattan"
  );
});
