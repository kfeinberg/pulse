import assert from 'node:assert/strict';
import test from 'node:test';
import { browseDays, dateKey, dayLabel, eventTimeLabel, matchesTime } from '../src/browseTime.ts';

const iso = (value) => Date.parse(value);

test('day labels and clocks always use the NYC calendar, including after UTC midnight', () => {
  const now = iso('2026-11-25T01:00:00Z');
  const tomorrow = iso('2026-11-25T15:00:00Z');
  assert.equal(dayLabel(iso('2026-11-25T04:30:00Z'), now), 'Today');
  assert.equal(dayLabel(tomorrow, now), 'Tomorrow');
  assert.equal(eventTimeLabel(now, now), 'Today, 8:00 PM');
  assert.deepEqual(browseDays(now).slice(0, 2).map(({ label }) => label), ['Today', 'Tomorrow']);
});

test('day view includes ongoing and later events, but not expired events', () => {
  const now = iso('2026-11-24T18:00:00Z');
  const day = dateKey(now);
  assert.equal(matchesTime(now - 1, now + 1, day, 'all', now), true);
  assert.equal(matchesTime(now + 90000, now + 180000, day, 'all', now), true);
  assert.equal(matchesTime(now - 1, now, day, 'all', now), false);
  assert.equal(matchesTime(now + 90000, now + 180000, day, now, now), false);
});

test('an event ending at midnight does not appear on the next day', () => {
  const now = iso('2026-11-24T23:00:00Z');
  const end = iso('2026-11-25T05:00:00Z');
  assert.equal(matchesTime(now, end, dateKey(end), 'all', now), false);
  assert.equal(matchesTime(now, end + 1, dateKey(end), 'all', now), true);
});

test('day matching spans month and year boundaries', () => {
  const now = iso('2026-12-31T20:00:00Z');
  const end = iso('2027-01-02T20:00:00Z');
  assert.equal(matchesTime(now, end, dateKey(iso('2027-01-01T17:00:00Z')), 'all', now), true);
  assert.equal(matchesTime(now, end, dateKey(iso('2027-01-03T17:00:00Z')), 'all', now), false);
});

test('spring forward skips a nonexistent hour; fall back preserves both 1 AM instants', () => {
  const spring = browseDays(iso('2026-03-08T04:30:00Z'))[1];
  assert.equal(spring.label, 'Tomorrow');
  assert.equal(spring.hours.length, 23);
  const fall = browseDays(iso('2026-11-01T03:30:00Z'))[1];
  assert.equal(fall.label, 'Tomorrow');
  assert.equal(fall.hours.length, 25);
  assert.notEqual(fall.hours[1], fall.hours[2]);
});
