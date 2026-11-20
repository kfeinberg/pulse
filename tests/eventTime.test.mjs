// Run: TZ=America/New_York node --experimental-strip-types --test tests/
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTimeline, eventStatus, formatClockRange, formatDayLabel, formatEventRange, isMultiDay,
  matchesSearch, nextBusySnap,
} from '../utils/eventTime.ts';

const at = (iso) => Date.parse(iso);
const NOW = at('2026-11-20T12:10:00-05:00'); // a Friday

test('runs in New York time', () => {
  assert.equal(new Date(NOW).getHours(), 12, 'set TZ=America/New_York');
});

test('clock ranges share a meridiem when they can', () => {
  assert.equal(formatClockRange(at('2026-11-20T19:00:00-05:00'), at('2026-11-20T22:00:00-05:00')), '7 – 10 PM');
  assert.equal(formatClockRange(at('2026-11-20T11:00:00-05:00'), at('2026-11-20T14:30:00-05:00')), '11 AM – 2:30 PM');
});

test('day labels are relative near today and dated after that', () => {
  assert.equal(formatDayLabel(at('2026-11-20T23:00:00-05:00'), NOW), 'Today');
  assert.equal(formatDayLabel(at('2026-11-21T01:00:00-05:00'), NOW), 'Tomorrow');
  assert.equal(formatDayLabel(at('2026-11-22T19:00:00-05:00'), NOW), 'Sun, Nov 22');
  assert.equal(formatDayLabel(at('2027-01-02T19:00:00-05:00'), NOW), 'Sat, Jan 2, 2027');
});

test('event ranges read naturally for one night, overnight and multi-day runs', () => {
  assert.equal(formatEventRange(at('2026-11-20T19:00:00-05:00'), at('2026-11-20T22:00:00-05:00'), NOW), 'Today · 7 – 10 PM');
  assert.equal(formatEventRange(at('2026-11-21T22:00:00-05:00'), at('2026-11-22T02:00:00-05:00'), NOW), 'Tomorrow · 10 PM – 2 AM');
  assert.equal(isMultiDay(at('2026-11-21T22:00:00-05:00'), at('2026-11-22T02:00:00-05:00')), false);
  assert.equal(formatEventRange(at('2026-11-14T10:00:00-05:00'), at('2027-02-21T18:00:00-05:00'), NOW), 'Nov 14 – Feb 21, 2027');
  assert.equal(formatEventRange(at('2026-11-20T10:00:00-05:00'), at('2026-11-21T19:00:00-05:00'), NOW), 'Nov 20 – Nov 21');
});

test('row status says what matters right now', () => {
  assert.equal(eventStatus(at('2026-11-20T12:30:00-05:00'), at('2026-11-20T15:00:00-05:00'), NOW), 'Starts in 20 min');
  assert.equal(eventStatus(at('2026-11-20T19:00:00-05:00'), at('2026-11-20T22:00:00-05:00'), NOW), 'Starts 7 PM');
  assert.equal(eventStatus(at('2026-11-21T19:00:00-05:00'), at('2026-11-21T22:00:00-05:00'), NOW), 'Starts Tomorrow 7 PM');
  assert.equal(eventStatus(at('2026-11-20T11:00:00-05:00'), at('2026-11-20T12:40:00-05:00'), NOW), 'Ends in 30 min');
  assert.equal(eventStatus(at('2026-11-20T11:00:00-05:00'), at('2026-11-20T17:00:00-05:00'), NOW), 'Until 5 PM');
  assert.equal(eventStatus(at('2026-11-14T10:00:00-05:00'), at('2027-02-21T18:00:00-05:00'), NOW), 'Through Feb 21, 2027');
  assert.equal(eventStatus(at('2026-11-18T10:00:00-05:00'), at('2026-11-20T18:00:00-05:00'), NOW), 'Ends today 6 PM');
  assert.equal(eventStatus(at('2026-11-20T09:00:00-05:00'), at('2026-11-20T11:00:00-05:00'), NOW), 'Ended');
});

test('the timeline starts at the live moment and re-anchors as time passes', () => {
  const snaps = buildTimeline(NOW, 72);
  assert.equal(snaps[0].label, 'Now');
  assert.equal(snaps[0].time.getTime(), NOW);
  assert.equal(snaps[1].label, 'Today 1PM');
  assert.equal(snaps.at(-1).time.getTime(), at('2026-11-23T12:00:00-05:00'));
  assert.equal(snaps.length, 73);
  const later = buildTimeline(at('2026-11-20T15:05:00-05:00'), 72);
  assert.equal(later[1].label, 'Today 4PM');
  assert.equal(later.find((snap) => snap.label === 'Sat 9AM').time.getTime(), at('2026-11-21T09:00:00-05:00'));
});

test('an empty hour offers the next hour with something on', () => {
  const snaps = buildTimeline(NOW, 12);
  const events = [
    { category: 'concerts', startMs: at('2026-11-20T19:00:00-05:00'), endMs: at('2026-11-20T22:00:00-05:00') },
    { category: 'bars', startMs: at('2026-11-20T15:00:00-05:00'), endMs: at('2026-11-20T16:00:00-05:00') },
  ];
  assert.deepEqual(nextBusySnap(snaps, 0, events, new Set(['concerts'])), { index: 7, count: 1 });
  assert.equal(snaps[7].label, 'Today 7PM');
  assert.deepEqual(nextBusySnap(snaps, 0, events, new Set(['bars', 'concerts'])), { index: 3, count: 1 });
  assert.equal(nextBusySnap(snaps, 0, events, new Set(['clubs'])), null);
});

test('search matches every word across title, place and description, ignoring accents and case', () => {
  const event = { title: 'Café Night Market', location: 'Industry City, Brooklyn', description: 'Vendors and DJs' };
  assert.equal(matchesSearch(event, 'cafe brooklyn'), true);
  assert.equal(matchesSearch(event, 'djs'), true);
  assert.equal(matchesSearch(event, '  '), true);
  assert.equal(matchesSearch(event, 'queens'), false);
});
