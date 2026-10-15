import { EventSource, ScrapedEvent } from "../base.js";
import { etTimestamp } from "../../services/etTime.js";

// NYC DOT's seasonal Trick-or-Streets page (car-free Halloween streets every
// October) is server-rendered HTML with two rigid tables — Signature Events
// and Partner Events — so rows are parsed deterministically without Muse.
// Outside the season the tables list only past events and this returns [].
const TRICK_OR_STREETS_URL =
  "https://www.nyc.gov/html/dot/html/pedestrians/trickorstreets.shtml";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const BOROUGH_PATTERN = "(Manhattan|Brooklyn|Queens|Bronx|Staten Island)";

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cellText(cellHtml: string): string {
  return decodeEntities(
    cellHtml
      .replace(/<br\s*\/?>/gi, ", ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .trim();
}

export function extractBorough(locationText: string): string {
  const match = locationText.match(
    new RegExp(`(?:in|on)\\s+(?:the\\s+)?${BOROUGH_PATTERN}\\s*$`, "i")
  );
  return match ? match[1].replace(/^the\s+/i, "") : "";
}

export function normalizeTrickLocation(
  locationText: string,
  strongTitle: string,
  borough: string
): { location: string; borough: string } {
  let work = locationText;
  const resolvedBorough = borough || extractBorough(work);
  work = work
    .replace(new RegExp(`[\\s,]+(?:in|on)\\s+(?:the\\s+)?${BOROUGH_PATTERN}\\s*$`, "i"), "")
    .trim();

  // "<Title> on <Street>, <A> to <B>" -> segment is after the title's "on"
  // (titles may themselves contain "on", e.g. "Halloween Fest on 5 Avenue").
  // "<Street>, <A> to <B>" -> the strong text is the street itself.
  let segment = work;
  if (work.toLowerCase().startsWith(strongTitle.toLowerCase())) {
    const rest = work.slice(strongTitle.length).trimStart();
    if (/^on\s+/i.test(rest)) {
      segment = rest.replace(/^on\s+/i, "").trim();
    } else if (rest.startsWith(",")) {
      segment = `${strongTitle}${rest}`;
    } else if (rest) {
      segment = rest;
    }
  }

  // Drop lane descriptors like "(northbound lane)" — they are not part of
  // the street name and break both display and geocoding.
  segment = segment.replace(/\s*\([^)]*\b(?:bound|lane)\b[^)]*\)/gi, "").trim();

  const stripAlt = (value: string) => value.split("/")[0].trim();
  let location: string;
  const range = segment.match(/^([^,]+),\s*(?:at\s+)?(.+?)\s+to\s+(.+)$/i);
  const at = segment.match(/^([^,]+),\s*at\s+(.+)$/i);
  const cross = segment.match(/^([^,]+),\s*(.+)$/);
  if (range) {
    const a = stripAlt(range[2]);
    const b = stripAlt(range[3]);
    location = /^dead\s+end$/i.test(a)
      ? `${range[1].trim()} & ${b}`
      : `${range[1].trim()} between ${a} and ${b}`;
  } else if (at) {
    location = `${at[1].trim()} at ${stripAlt(at[2])}`;
  } else if (cross) {
    location = `${cross[1].trim()} & ${stripAlt(cross[2])}`;
  } else {
    location = segment;
  }

  return {
    location: resolvedBorough
      ? `${ordinalizeStreets(location)}, ${resolvedBorough}`
      : ordinalizeStreets(location),
    borough: resolvedBorough,
  };
}

function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

// DOT writes numbered streets without ordinals ("32 Street", "7 Avenue");
// OSM names them "32nd Street" / "7th Avenue", which junction geocoding needs.
export function ordinalizeStreets(location: string): string {
  return location.replace(
    /\b(\d+)\s+(Street|Avenue|Place|Road|Boulevard|Drive|Terrace|Lane|Court)\b/g,
    (_, num: string, suffix: string) => `${ordinal(Number(num))} ${suffix}`
  );
}

const EVENT_WORDING =
  /halloween|trick-or|trick or|parade|party|fest|celebration|spooktacular|block party|nightmare|safety walk|spooky/i;

export function displayTitle(strongTitle: string): string {
  return EVENT_WORDING.test(strongTitle)
    ? strongTitle
    : `Trick-or-Streets: ${strongTitle}`;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function to24Hour(hour: number, meridiem: string): number {
  const pm = /^p/i.test(meridiem);
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

export function parseDateAndTime(
  dateText: string,
  timeText: string
): { startTimestamp: number; endTimestamp: number } | null {
  const date = dateText.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const time = timeText.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*to\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
  );
  if (!date || !time) return null;
  const month = MONTHS[date[1].toLowerCase()];
  if (!month) return null;
  const day = Number(date[2]);
  const year = Number(date[3]);
  const startTimestamp = etTimestamp(
    year, month, day,
    to24Hour(Number(time[1]), time[3]), Number(time[2] ?? 0)
  );
  let endTimestamp = etTimestamp(
    year, month, day,
    to24Hour(Number(time[4]), time[6]), Number(time[5] ?? 0)
  );
  if (endTimestamp <= startTimestamp) {
    endTimestamp += 24 * 60 * 60 * 1000;
  }
  return { startTimestamp, endTimestamp };
}

export function parseTrickOrStreets(html: string, nowMs: number): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];
  const seen = new Set<string>();

  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tablePattern.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    if (!/Event Date/i.test(tableHtml)) continue;

    const headers: string[] = [];
    const headerPattern = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let headerMatch;
    while ((headerMatch = headerPattern.exec(tableHtml)) !== null) {
      headers.push(cellText(headerMatch[1]).toLowerCase());
    }
    const columnOf = (label: string) => headers.findIndex((h) => h.includes(label));
    const locationCol = Math.max(columnOf("location"), 0);
    const boroughCol = columnOf("borough");
    const orgCol = columnOf("organization");
    const dateCol = columnOf("event date");
    const timeCol = columnOf("event time");
    if (dateCol < 0 || timeCol < 0) continue;

    const rowPattern = /<tr>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
      const cells: string[] = [];
      const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
        cells.push(cellMatch[1]);
      }
      if (cells.length <= Math.max(dateCol, timeCol)) continue;

      const locationCell = cells[locationCol] ?? "";
      const strong = locationCell.match(/<strong>([\s\S]*?)<\/strong>/i);
      if (!strong) continue;
      const strongTitle = cellText(strong[1]).replace(/,$/, "");
      if (!strongTitle) continue;

      const dateText = cellText(cells[dateCol]);
      const timeText = cellText(cells[timeCol]);
      const times = parseDateAndTime(dateText, timeText);
      if (!times || times.endTimestamp < nowMs) continue;

      const boroughCell = boroughCol >= 0 ? cellText(cells[boroughCol]) : "";
      const { location } = normalizeTrickLocation(
        cellText(locationCell),
        strongTitle,
        boroughCell.replace(/^the\s+/i, "")
      );
      const title = displayTitle(strongTitle);
      const dedupeKey = `${title}|${times.startTimestamp}|${location}`.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const org = orgCol >= 0 ? cellText(cells[orgCol]) : "";
      events.push({
        title,
        description: org
          ? `NYC DOT Trick-or-Streets car-free Halloween celebration hosted by ${org.replace(/\.$/, "")}.`
          : "NYC DOT Trick-or-Streets car-free Halloween celebration.",
        startTimestamp: times.startTimestamp,
        endTimestamp: times.endTimestamp,
        location,
        category: "trick_or_treat",
        sourceUrl: TRICK_OR_STREETS_URL,
        sourceName: "trickorstreets",
        temporalStatus: "scheduled_event",
        temporalEvidence: `NYC DOT Trick-or-Streets listing for ${dateText}, ${timeText}`,
      });
    }
  }

  return events.sort((a, b) => a.startTimestamp - b.startTimestamp);
}

export function createTrickOrStreetsScraper(): EventSource {
  return {
    name: "trickorstreets",
    async scrape(): Promise<ScrapedEvent[]> {
      console.log(`Fetching Trick-or-Streets: ${TRICK_OR_STREETS_URL}`);
      const response = await fetch(TRICK_OR_STREETS_URL, { headers: FETCH_HEADERS });
      if (!response.ok) {
        console.error(`Trick-or-Streets fetch failed (${response.status})`);
        return [];
      }
      const html = await response.text();
      console.log(`Trick-or-Streets HTML: ${html.length} chars`);
      const events = parseTrickOrStreets(html, Date.now());
      console.log(`Trick-or-Streets: ${events.length} upcoming events`);
      return events;
    },
  };
}
