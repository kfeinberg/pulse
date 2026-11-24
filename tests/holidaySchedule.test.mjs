import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOLIDAY_CATEGORIES, REGULAR_CATEGORIES, classifyListing, displayMobileCategory,
  nycCivilDay, seasonalCategories, storeMobileCategory, visibleSelection,
} from '../utils/holidaySchedule.ts';

const activeAt = (instant) => seasonalCategories(nycCivilDay(Date.parse(instant)));
const onDate = (date) => activeAt(`${date}T17:00:00Z`);
const civilDate = (key, year) => new Date(HOLIDAY_CATEGORIES[key].date(year) * 86_400_000).toISOString().slice(0, 10);

test('Christmas follows NYC midnight and stays on through January 6', () => {
  assert.ok(!activeAt('2026-11-20T04:59:59Z').includes('christmas'));
  assert.ok(activeAt('2026-11-20T05:00:00Z').includes('christmas'));
  assert.deepEqual(onDate('2026-11-24'), ['thanksgiving', 'christmas']);
  assert.ok(activeAt('2027-01-07T04:59:59Z').includes('christmas'));
  assert.ok(!activeAt('2027-01-07T05:00:00Z').includes('christmas'));
});

test('New Year spans the Gregorian year boundary and date-based windows recur', () => {
  assert.ok(onDate('2026-12-26').includes('new_year'));
  assert.ok(onDate('2027-01-02').includes('new_year'));
  assert.ok(!onDate('2027-01-03').includes('new_year'));
  assert.ok(onDate('2027-10-14').includes('halloween'));
  assert.ok(!onDate('2027-10-13').includes('halloween'));
  assert.ok(!onDate('2027-11-03').includes('halloween'));
  assert.ok(onDate('2027-03-17').includes('st_patricks'));
  assert.ok(!onDate('2027-03-21').includes('st_patricks'));
});

test('movable holidays use their calendar dates, not last year’s dates', () => {
  assert.equal(civilDate('thanksgiving', 2026), '2026-11-26');
  assert.equal(civilDate('thanksgiving', 2027), '2027-11-25');
  assert.equal(civilDate('easter', 2027), '2027-03-28');
  assert.equal(civilDate('memorial_day', 2027), '2027-05-31');
  assert.equal(civilDate('labor_day', 2027), '2027-09-06');
  assert.equal(civilDate('hanukkah', 2026), '2026-12-05'); // Begins the preceding evening.
  assert.equal(civilDate('lunar_new_year', 2026), '2026-02-17');
  assert.equal(civilDate('lunar_new_year', 2027), '2027-02-06');
  assert.equal(civilDate('lunar_new_year', 2030), '2030-02-03');
});

test('the date relabels matching listings but preserves original categories out of season', () => {
  const market = classifyListing({ title: 'Chinatown Holiday Market', category: 'street_fair' });
  assert.deepEqual(market, { category: 'street_fair', holiday: 'christmas' });
  assert.equal(displayMobileCategory(market, onDate('2026-12-10')), 'christmas');
  assert.equal(displayMobileCategory(market, onDate('2027-01-10')), 'street_fair');
  const legacy = classifyListing({ title: 'Neighborhood Parade', category: 'trick_or_treat' });
  assert.equal(displayMobileCategory(legacy, onDate('2026-10-31')), 'halloween');
  assert.equal(displayMobileCategory(legacy, onDate('2026-11-03')), 'happening');
  const ordinary = classifyListing({ title: 'December Jazz Night', category: 'concerts' });
  assert.equal(displayMobileCategory(ordinary, onDate('2026-12-10')), 'concerts');
});

test('explicit holiday themes win over generic holiday phrasing', () => {
  for (const [title, holiday] of [
    ['Hanukkah Holiday Market', 'hanukkah'], ['Halloween Holiday Market', 'halloween'],
    ['Thanksgiving Parade', 'thanksgiving'], ['St. Patrick’s Day Parade', 'st_patricks'],
    ['NYC Lunar New Year Parade', 'lunar_new_year'], ['New Year’s Eve at Winter Village', 'new_year'],
    ['Fourth of July Fireworks', 'fourth_of_july'],
  ]) assert.equal(classifyListing({ category: 'happening', title }).holiday, holiday);
  assert.equal(classifyListing({ title: 'Pop-up on December 25', category: 'popup' }).holiday, undefined);
});

test('admin tagging stays readable in old clients and respects the season', () => {
  const stored = storeMobileCategory('st_patricks');
  assert.deepEqual(stored, { category: 'happening', seasonalCategory: 'st_patricks' });
  const listing = classifyListing({ ...stored, title: 'Neighborhood Parade' });
  assert.equal(displayMobileCategory(listing, onDate('2027-03-17')), 'st_patricks');
  assert.equal(displayMobileCategory(listing, onDate('2027-03-21')), 'happening');
  assert.deepEqual(storeMobileCategory('concerts'), { category: 'concerts' });
});

test('All opts into newly active filters and an expired solo holiday cannot hide the feed', () => {
  const christmas = [...REGULAR_CATEGORIES, 'christmas'];
  const halloween = [...REGULAR_CATEGORIES, 'halloween'];
  assert.ok(visibleSelection(christmas, null).has('christmas'));
  assert.ok(!visibleSelection(christmas, null).has('halloween'));
  assert.deepEqual([...visibleSelection(christmas, new Set(['halloween']))], christmas);
  assert.deepEqual([...visibleSelection(halloween, new Set(['halloween', 'bars']))], ['bars', 'halloween']);
  assert.deepEqual([...visibleSelection(christmas, new Set(['halloween', 'bars']))], ['bars']);
});
