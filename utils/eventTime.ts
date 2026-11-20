// Pure time/search helpers for the event map and list. No React Native
// imports, so they can be unit-tested with plain Node (tests/eventTime.test.mjs).

export const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface TimelineSnap {
  label: string;
  time: Date;
}

function startOfDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

// Whole calendar days from `now`'s day to `ms`'s day (0 = today).
export function dayOffset(ms: number, now: number): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
}

function clockParts(ms: number): { time: string; meridiem: 'AM' | 'PM' } {
  const date = new Date(ms);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const hour12 = hours % 12 || 12;
  return {
    time: minutes === 0 ? `${hour12}` : `${hour12}:${String(minutes).padStart(2, '0')}`,
    meridiem: hours < 12 ? 'AM' : 'PM',
  };
}

// "7 PM", "7:30 PM"
export function formatClock(ms: number): string {
  const { time, meridiem } = clockParts(ms);
  return `${time} ${meridiem}`;
}

// "7 – 10 PM", "11 AM – 2:30 PM"
export function formatClockRange(start: number, end: number): string {
  const a = clockParts(start);
  const b = clockParts(end);
  return a.meridiem === b.meridiem ? `${a.time} – ${b.time} ${b.meridiem}` : `${a.time} ${a.meridiem} – ${b.time} ${b.meridiem}`;
}

// "Today", "Tomorrow", "Sat, Nov 22" (with the year when it is not this year)
export function formatDayLabel(ms: number, now: number): string {
  const offset = dayOffset(ms, now);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  const date = new Date(ms);
  const year = date.getFullYear() !== new Date(now).getFullYear() ? `, ${date.getFullYear()}` : '';
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}${year}`;
}

function formatShortDate(ms: number, now: number): string {
  const date = new Date(ms);
  const year = date.getFullYear() !== new Date(now).getFullYear() ? `, ${date.getFullYear()}` : '';
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}`;
}

// A run that ends after the early morning of a later day is a multi-day run;
// a show that ends at 2 AM the next morning is still one night.
export function isMultiDay(start: number, end: number): boolean {
  if (end - start >= DAY_MS) return true;
  const endsOnLaterDay = dayOffset(end, start) > 0;
  return endsOnLaterDay && new Date(end).getHours() >= 6;
}

// "Today · 7 – 10 PM", "Sat, Nov 22 · 10 PM – 2 AM", "Nov 14 – Feb 21"
export function formatEventRange(start: number, end: number, now: number): string {
  if (isMultiDay(start, end)) {
    return `${formatShortDate(start, now)} – ${formatShortDate(end, now)}`;
  }
  return `${formatDayLabel(start, now)} · ${formatClockRange(start, end)}`;
}

function minutesUntil(ms: number, now: number): number {
  return Math.max(1, Math.round((ms - now) / 60000));
}

// Short status for list rows: what matters about this event right now.
export function eventStatus(start: number, end: number, now: number): string {
  if (now >= end) return 'Ended';
  if (now < start) {
    if (start - now < HOUR_MS) return `Starts in ${minutesUntil(start, now)} min`;
    const day = dayOffset(start, now);
    return day === 0 ? `Starts ${formatClock(start)}` : `Starts ${formatDayLabel(start, now)} ${formatClock(start)}`;
  }
  if (isMultiDay(start, end)) {
    return dayOffset(end, now) === 0 ? `Ends today ${formatClock(end)}` : `Through ${formatShortDate(end, now)}`;
  }
  if (end - now < HOUR_MS) return `Ends in ${minutesUntil(end, now)} min`;
  return `Until ${formatClock(end)}`;
}

// "Now" plus every whole hour from the next one through `hours` from now.
export function buildTimeline(now: number, hours: number): TimelineSnap[] {
  const snaps: TimelineSnap[] = [{ label: 'Now', time: new Date(now) }];
  const end = now + hours * HOUR_MS;
  const first = new Date(now);
  first.setMinutes(0, 0, 0);
  first.setHours(first.getHours() + 1);
  for (let time = first.getTime(); time <= end; time += HOUR_MS) {
    const date = new Date(time);
    const offset = dayOffset(time, now);
    const day = offset === 0 ? 'Today' : WEEKDAYS[date.getDay()];
    snaps.push({ label: `${day} ${formatClock(time).replace(' ', '')}`, time: date });
  }
  return snaps;
}

export interface TimedEvent {
  category: string;
  startMs: number;
  endMs: number;
}

export function isHappeningAt(event: TimedEvent, time: number): boolean {
  return event.startMs <= time && event.endMs > time;
}

// The first later snap with something on, to offer from an empty list.
export function nextBusySnap(
  snaps: TimelineSnap[],
  fromIndex: number,
  events: TimedEvent[],
  categories: ReadonlySet<string>
): { index: number; count: number } | null {
  for (let index = fromIndex + 1; index < snaps.length; index++) {
    const time = snaps[index].time.getTime();
    const count = events.filter((event) => categories.has(event.category) && isHappeningAt(event, time)).length;
    if (count > 0) return { index, count };
  }
  return null;
}

function fold(value: string): string {
  try {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  } catch {
    return value.toLowerCase(); // An engine without Unicode normalization still searches.
  }
}

// Every word of the query must appear in the title, place or description.
export function matchesSearch(
  event: { title: string; location?: string; description?: string },
  query: string
): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(`${event.title} ${event.location ?? ''} ${event.description ?? ''}`);
  return words.every((word) => haystack.includes(word));
}
