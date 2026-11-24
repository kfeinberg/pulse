const HOUR = 60 * 60_000;
const NYC = 'America/New_York';
const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: NYC, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: NYC, weekday: 'short', month: 'short', day: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: NYC, hour: 'numeric', minute: '2-digit' });
const zonedTimeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: NYC, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export function hourOptions(hours: number[]) {
  const labels = hours.map(timeLabel);
  return hours.map((hour, i) => ({
    hour,
    label: labels.indexOf(labels[i]) === labels.lastIndexOf(labels[i]) ? labels[i] : zonedTimeFormatter.format(hour),
  }));
}

export function dateKey(time: number) {
  return dateFormatter.format(time);
}

export function dayLabel(time: number, now: number) {
  if (dateKey(time) === dateKey(now)) return 'Today';
  // Compare calendar dates rather than adding 24 hours to "now" across DST.
  const [month, day, year] = dateKey(now).split('/').map(Number);
  const tomorrow = Date.UTC(year, month - 1, day + 1, 12);
  return dateKey(time) === dateKey(tomorrow) ? 'Tomorrow' : dayFormatter.format(time);
}

export function timeLabel(time: number) {
  return timeFormatter.format(time);
}

export function eventTimeLabel(time: number, now: number) {
  return `${dayLabel(time, now)}, ${timeLabel(time)}`;
}

export function browseDays(now: number) {
  const days = new Map<string, { key: string; label: string; hours: number[] }>();
  const add = (instant: number, isHour: boolean) => {
    const key = dateKey(instant);
    const day = days.get(key) ?? { key, label: dayLabel(instant, now), hours: [] };
    if (isHour) day.hours.push(instant);
    days.set(key, day);
  };
  add(now, false);
  for (let hour = (Math.floor(now / HOUR) + 1) * HOUR; hour <= now + 72 * HOUR; hour += HOUR) {
    add(hour, true);
  }
  return [...days.values()];
}

export function matchesTime(start: number, end: number, day: string, time: number | 'all', now: number) {
  if (end <= now) return false;
  if (time !== 'all') return start <= time && end > time;
  // en-US date strings aren't lexically ordered, so compare year, month, day.
  const order = (key: string) => key.slice(6) + key.slice(0, 2) + key.slice(3, 5);
  return order(dateKey(start)) <= order(day) && order(dateKey(end - 1)) >= order(day);
}
