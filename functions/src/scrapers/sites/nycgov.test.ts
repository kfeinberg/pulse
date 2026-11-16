import assert from "node:assert/strict";
import test from "node:test";

import {
  boroughName,
  buildSearchUrl,
  detailUrl,
  forcedCategory,
  isFarmersMarket,
  normalizeSapoAddress,
  passesWeekdayFilter,
  titleWeekdays,
  type NycGovEventItem,
} from "./nycgov.js";

function item(overrides: Partial<NycGovEventItem>): NycGovEventItem {
  return {
    id: 1,
    sequence: 1,
    name: "Test Event",
    startDate: "2026-10-14T08:00:00.000-04:00", // Wednesday in ET
    permalink: "https://www1.nyc.gov/events/test-event/1/1",
    ...overrides,
  };
}

test("titleWeekdays finds full and abbreviated weekday names", () => {
  assert.deepEqual(titleWeekdays("Inwood Greenmarket Saturday"), ["saturday"]);
  assert.deepEqual(titleWeekdays("Columbia Thursday Sunday Greenmarket"), [
    "sunday",
    "thursday",
  ]);
  assert.deepEqual(titleWeekdays("Lincoln Hospital Greenmarket Tues  Friday"), [
    "tuesday",
    "friday",
  ]);
  assert.deepEqual(titleWeekdays("Murray Hill Farmers Market"), []);
});

test("weekday filter drops wrong-day market instances only for markets with title weekdays", () => {
  // Oct 14, 2026 is a Wednesday.
  assert.equal(passesWeekdayFilter(item({ name: "Inwood Greenmarket Saturday" })), false);
  assert.equal(passesWeekdayFilter(item({ name: "Mount Sinai Greenmarket Wednesday" })), true);
  assert.equal(passesWeekdayFilter(item({ name: "Columbia Thursday Sunday Greenmarket" })), false);
  // No weekday in the title: kept as listed.
  assert.equal(passesWeekdayFilter(item({ name: "Murray Hill Farmers Market" })), true);
  assert.equal(passesWeekdayFilter(item({ name: "HHFM East Harlem Market", shortDesc: "Farmers Market" })), true);
  // Non-markets are never weekday-filtered.
  assert.equal(passesWeekdayFilter(item({ name: "Saturday Morning Parade", shortDesc: "Parade" })), true);
});

test("isFarmersMarket uses title patterns and the SAPO permit type", () => {
  assert.equal(isFarmersMarket(item({ name: "East 125th Street Farmstand" })), true);
  assert.equal(isFarmersMarket(item({ name: "170 Farm Stand" })), true);
  assert.equal(isFarmersMarket(item({ name: "HHFM East Harlem Market", shortDesc: "Farmers Market" })), true);
  assert.equal(isFarmersMarket(item({ name: "Pompeii Flea Market", shortDesc: "Sidewalk Sale" })), false);
});

test("forcedCategory maps permit types and explicit titles, leaves the rest to Claude", () => {
  assert.equal(forcedCategory(item({ name: "Broadway Astoria Fall Fair", shortDesc: "Street Festival" })), "street_fair");
  assert.equal(forcedCategory(item({ name: "Korean Harvest Festival", shortDesc: "Single Block Festival" })), "street_fair");
  assert.equal(forcedCategory(item({ name: "Pompeii Flea Market", shortDesc: "Sidewalk Sale" })), "street_fair");
  assert.equal(forcedCategory(item({ name: "Annual Block Party" })), "street_fair");
  assert.equal(forcedCategory(item({ name: "Columbus Day Parade", shortDesc: "Parade" })), undefined);
  // Farmers market wins over anything else.
  assert.equal(forcedCategory(item({ name: "97 Street Greenmarket Friday", shortDesc: "Farmers Market" })), "farmers_market");
});

test("normalizeSapoAddress title-cases SHOUTING segment addresses and ordinalizes streets", () => {
  assert.equal(
    normalizeSapoAddress(
      item({ address: " 2 AVENUE between EAST   32 STREET and EAST   33 STREET  Manhattan", boroughs: ["Mn"] })
    ),
    "2nd Avenue between East 32nd Street and East 33rd Street, Manhattan"
  );
  assert.equal(
    normalizeSapoAddress(
      item({ address: " ISHAM STREET between SEAMAN AVENUE and COOPER STREET  Manhattan", boroughs: ["Mn"] })
    ),
    "Isham Street between Seaman Avenue and Cooper Street, Manhattan"
  );
  // Short street names have a lower uppercase ratio ("between"/"and" are
  // lowercase in the feed) but are still SAPO-shouted addresses.
  assert.equal(
    normalizeSapoAddress(
      item({ address: " WEST   23 STREET between 8 AVENUE and 9 AVENUE  Manhattan", boroughs: ["Mn"] })
    ),
    "West 23rd Street between 8th Avenue and 9th Avenue, Manhattan"
  );
  assert.equal(
    normalizeSapoAddress(
      item({ address: "AVENUE OF AMERICAS between CARMINE STREET and WEST 3 STREET Manhattan", boroughs: ["Mn"] })
    ),
    "Avenue of Americas between Carmine Street and West 3rd Street, Manhattan"
  );
  // House numbers are not ordinalized.
  assert.equal(
    normalizeSapoAddress(item({ address: "1545 FLATBUSH AVENUE Brooklyn", boroughs: ["Bk"] })),
    "1545 Flatbush Avenue, Brooklyn"
  );
  // Mixed-case addresses pass through apart from whitespace.
  assert.equal(
    normalizeSapoAddress(item({ address: "Poe Park:  Permit Area 1", boroughs: ["Bx"] })),
    "Poe Park: Permit Area 1, Bronx"
  );
});

test("boroughName maps API borough codes", () => {
  assert.equal(boroughName(item({ boroughs: ["Qn"] })), "Queens");
  assert.equal(boroughName(item({ boroughs: ["Ot"] })), "");
  assert.equal(boroughName(item({ boroughs: [] })), "");
});

test("detailUrl builds the nyc.gov/main/events detail link", () => {
  assert.equal(
    detailUrl(
      item({
        id: 1293216,
        sequence: 285,
        permalink: "https://www1.nyc.gov/events/inwood-greenmarket-saturday/1293216/285",
      })
    ),
    "https://www.nyc.gov/main/events/?permalinkName=inwood-greenmarket-saturday&id=1293216&sequence=285"
  );
});

test("buildSearchUrl targets calendar/search with the UI date format", () => {
  const url = buildSearchUrl(
    "https://api.nyc.gov/",
    { year: 2026, month: 10, day: 14 },
    { year: 2026, month: 10, day: 16 },
    2
  );
  assert.match(url, /^https:\/\/api\.nyc\.gov\/calendar\/search\?/);
  assert.match(url, /agency=nyc_gov/);
  assert.match(url, /categories=Street(?:\+|%20)and(?:\+|%20)Neighborhood/);
  assert.match(url, /startDate=10%2F14%2F2026/);
  assert.match(url, /pageNumber=2/);
});
