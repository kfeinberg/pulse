import assert from "node:assert/strict";
import test from "node:test";

import {
  displayTitle,
  normalizeTrickLocation,
  parseDateAndTime,
  parseTrickOrStreets,
} from "./trickorstreets.js";

// Modeled on the live DOT page markup (signature + partner tables).
const PAGE_HTML = `
<table border="0" class="tabular-list table-striped">
  <thead><tr>
    <th>Location</th><th>Free Guided Walking Tour </th><th>Organization Name</th><th>Event Date</th><th>Event Time</th>
  </tr></thead>
  <tbody>
    <tr>
      <td><strong>Hillel Plaza</strong> on Hillel Place,<br>Kenilworth Place to Flatbush Avenue in Brooklyn</td>
      <td></td>
      <td>Flatbush Nostrand Junction Business Improvement District</td>
      <td>Thursday, October 22, 2026</td>
      <td>2:00 PM to 6:00 PM</td>
    </tr>
    <tr>
      <td><strong>James Baldwin Plaza</strong> on Goulden Avenue,<br>at Mosholu Parkway in the Bronx</td>
      <td></td>
      <td>James Baldwin Outdoor Learning Center</td>
      <td>Saturday, October 31, 2026</td>
      <td>10:00 AM to 3:00 PM</td>
    </tr>
  </tbody>
</table>
<table border="0" class="tabular-list table-striped">
  <thead><tr>
    <th>Location</th><th>Borough</th><th>Organization Name</th><th>Event Date</th><th>Event Time</th>
  </tr></thead>
  <tbody>
    <tr>
      <td><strong>Vanderbilt Avenue Open Street</strong> on Vanderbilt Avenue,<br>Park Place to Atlantic Avenue</td>
      <td>Brooklyn</td>
      <td>Prospect Heights Open Streets, Inc.</td>
      <td>Saturday, October 3, 2026</td>
      <td>12:00 PM to 10:00 PM</td>
    </tr>
    <tr>
      <td><strong>36th Tompkins Square Halloween Dog Parade</strong> on Avenue B,<br>East 3 Street to East 14 Street</td>
      <td>Manhattan</td>
      <td>New York Dog Parade</td>
      <td>Saturday, October 17, 2026</td>
      <td>12:00 PM to 5:00 PM</td>
    </tr>
    <tr>
      <td><strong>Murdock Plaza</strong> on Murdock Avenue,<br>Dead End to 180 Street</td>
      <td>Queens</td>
      <td>Addisleigh Park Civic Organization</td>
      <td>Saturday, October 24, 2026</td>
      <td>12:00 PM to 5:00 PM</td>
    </tr>
  </tbody>
</table>`;

const OCT_1_2026 = Date.parse("2026-10-01T12:00:00.000Z");

test("parseTrickOrStreets parses both signature and partner tables", () => {
  const events = parseTrickOrStreets(PAGE_HTML, OCT_1_2026);
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.category === "trick_or_treat"));
  assert.ok(events.every((e) => e.temporalStatus === "scheduled_event"));

  const vanderbilt = events[0];
  assert.equal(vanderbilt.title, "Trick-or-Streets: Vanderbilt Avenue Open Street");
  assert.equal(
    vanderbilt.location,
    "Vanderbilt Avenue between Park Place and Atlantic Avenue, Brooklyn"
  );
  assert.match(vanderbilt.description, /hosted by Prospect Heights Open Streets, Inc\./);

  const dogParade = events.find((e) => e.title.includes("Dog Parade"));
  assert.equal(dogParade?.title, "36th Tompkins Square Halloween Dog Parade");
  assert.equal(
    dogParade?.location,
    "Avenue B between East 3rd Street and East 14th Street, Manhattan"
  );

  const hillel = events.find((e) => e.title.includes("Hillel"));
  assert.equal(
    hillel?.location,
    "Hillel Place between Kenilworth Place and Flatbush Avenue, Brooklyn"
  );
  // Oct 22, 2026 14:00 EDT = 18:00 UTC.
  assert.equal(new Date(hillel!.startTimestamp).toISOString(), "2026-10-22T18:00:00.000Z");

  const baldwin = events.find((e) => e.title.includes("James Baldwin"));
  assert.equal(baldwin?.location, "Goulden Avenue at Mosholu Parkway, Bronx");

  const murdock = events.find((e) => e.title.includes("Murdock"));
  assert.equal(murdock?.location, "Murdock Avenue & 180th Street, Queens");
});

test("parseTrickOrStreets drops past events and dedupes repeated rows", () => {
  const events = parseTrickOrStreets(PAGE_HTML + PAGE_HTML, Date.parse("2026-10-20T12:00:00.000Z"));
  assert.deepEqual(
    events.map((e) => e.title),
    [
      "Trick-or-Streets: Hillel Plaza",
      "Trick-or-Streets: Murdock Plaza",
      "Trick-or-Streets: James Baldwin Plaza",
    ]
  );
});

test("normalizeTrickLocation handles street-name titles and alternate names after a slash", () => {
  const castleton = normalizeTrickLocation(
    "Castleton Avenue, Bement Avenue to Davis Avenue",
    "Castleton Avenue",
    "Staten Island"
  );
  assert.equal(
    castleton.location,
    "Castleton Avenue between Bement Avenue and Davis Avenue, Staten Island"
  );
  const macombs = normalizeTrickLocation(
    "Macombs Place, West 150 Street to Frederick Douglass Boulevard / Macombs Place",
    "Macombs Place",
    "Manhattan"
  );
  assert.equal(
    macombs.location,
    "Macombs Place between West 150th Street and Frederick Douglass Boulevard, Manhattan"
  );
});

test("normalizeTrickLocation does not duplicate titles containing 'on <Street>'", () => {
  const fest = normalizeTrickLocation(
    "Halloween Fest on 5 Avenue on 5 Avenue, 85 Street to 72 Street",
    "Halloween Fest on 5 Avenue",
    "Brooklyn"
  );
  assert.equal(fest.location, "5th Avenue between 85th Street and 72nd Street, Brooklyn");
  const queens32 = normalizeTrickLocation(
    "32 Street, 30 Avenue to Newtown Avenue",
    "32 Street",
    "Queens"
  );
  assert.equal(queens32.location, "32nd Street between 30th Avenue and Newtown Avenue, Queens");
});

test("normalizeTrickLocation strips lane descriptors from street names", () => {
  const result = normalizeTrickLocation(
    "Broadway (northbound lane), West 75 Street to West 73 Street",
    "Broadway (northbound lane)",
    "Manhattan"
  );
  assert.equal(result.location, "Broadway between West 75th Street and West 73rd Street, Manhattan");
});

test("displayTitle prefixes plain street names but keeps real event names", () => {
  assert.equal(displayTitle("Castleton Avenue"), "Trick-or-Streets: Castleton Avenue");
  assert.equal(displayTitle("Washington Empire Plaza"), "Trick-or-Streets: Washington Empire Plaza");
  assert.equal(
    displayTitle("Annual Clinton Hill Halloween Safety Walk with Street Activities"),
    "Annual Clinton Hill Halloween Safety Walk with Street Activities"
  );
  assert.equal(displayTitle("Halloween on B Street"), "Halloween on B Street");
});

test("parseDateAndTime handles noon, late night, and minute-less times", () => {
  const noon = parseDateAndTime("Saturday, October 31, 2026", "12:00 PM to 11:59 PM");
  assert.equal(new Date(noon!.startTimestamp).toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(new Date(noon!.endTimestamp).toISOString(), "2026-11-01T03:59:00.000Z");
  const plain = parseDateAndTime("Saturday, October 31, 2026", "3 PM to 8 PM");
  assert.equal(new Date(plain!.startTimestamp).toISOString(), "2026-10-31T19:00:00.000Z");
  assert.equal(parseDateAndTime("TBD", "3 PM to 8 PM"), null);
});
