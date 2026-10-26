import assert from "node:assert/strict";
import test from "node:test";

import { segmentQueries } from "./geocoder.js";

test("segmentQueries builds junction and street-only queries for between segments", () => {
  const { junctionQueries, streetOnlyQuery } = segmentQueries(
    "Isham Street between Seaman Avenue and Cooper Street, Manhattan"
  );
  assert.deepEqual(junctionQueries, [
    "Seaman Avenue & Isham Street, Manhattan, New York, NY",
    "Isham Street & Seaman Avenue, Manhattan, New York, NY",
    "Cooper Street & Isham Street, Manhattan, New York, NY",
    "Isham Street & Cooper Street, Manhattan, New York, NY",
  ]);
  assert.equal(streetOnlyQuery, "Isham Street, Manhattan, New York, NY");
});

test("segmentQueries handles from/to segments and numeric streets", () => {
  const { junctionQueries, streetOnlyQuery } = segmentQueries(
    "7th Avenue from 47th Street to 57th Street, Manhattan"
  );
  assert.equal(junctionQueries[0], "47th Street & 7th Avenue, Manhattan, New York, NY");
  assert.equal(streetOnlyQuery, "7th Avenue, Manhattan, New York, NY");
});

test("segmentQueries skips Dead End cross streets", () => {
  const { junctionQueries } = segmentQueries(
    "Murdock Avenue between Dead End and 180 Street, Queens"
  );
  assert.deepEqual(junctionQueries, [
    "180 Street & Murdock Avenue, Queens, New York, NY",
    "Murdock Avenue & 180 Street, Queens, New York, NY",
  ]);
});

test("segmentQueries handles at/& intersections", () => {
  assert.deepEqual(
    segmentQueries("Goulden Avenue at Mosholu Parkway, Bronx").junctionQueries,
    [
      "Goulden Avenue & Mosholu Parkway, Bronx, New York, NY",
      "Mosholu Parkway & Goulden Avenue, Bronx, New York, NY",
    ]
  );
  assert.equal(
    segmentQueries("Vanderbilt Avenue & Park Place, Brooklyn").streetOnlyQuery,
    "Vanderbilt Avenue, Brooklyn, New York, NY"
  );
});

test("segmentQueries picks the street after a venue prefix", () => {
  const { streetOnlyQuery } = segmentQueries(
    "Union Square, 17th Street between Broadway and Park Avenue South, Manhattan"
  );
  assert.equal(streetOnlyQuery, "17th Street, Manhattan, New York, NY");
});

test("segmentQueries returns nothing for plain venue addresses", () => {
  for (const location of [
    "e's Bar, 511 Amsterdam Ave, Manhattan",
    "Central Park Great Lawn",
    "123 Broadway, New York, NY",
  ]) {
    assert.deepEqual(segmentQueries(location), {
      junctionQueries: [],
      streetOnlyQuery: null,
    });
  }
});
