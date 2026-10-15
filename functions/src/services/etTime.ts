// Eastern Time helpers for scrapers that parse wall-clock dates/times
// deterministically (no Claude pass). Uses Intl so DST transitions are
// handled correctly instead of approximating by month.

const TIME_ZONE = "America/New_York";

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function etDateParts(nowMs: number): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function etWeekday(nowMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
  }).format(new Date(nowMs));
}

export function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function formatUsDate(parts: DateParts): string {
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${mm}/${dd}/${parts.year}`;
}

function tzOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = value("hour") % 24; // some environments emit 24 at midnight
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second")
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Unix ms for a wall-clock time in America/New_York.
export function etTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute);
  let result = guessUtc - tzOffsetMs(guessUtc);
  // Re-check once so times on DST transition days use the post-transition offset.
  const refined = guessUtc - tzOffsetMs(result);
  if (refined !== result) result = refined;
  return result;
}
