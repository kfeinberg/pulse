import { extractText, getDocumentProxy } from "unpdf";
import { EventSource, ScrapedEvent } from "../base.js";
import { etDateParts, etTimestamp } from "../../services/etTime.js";

// https://nycstreetfairs.com/event-schedule/ embeds the current season's
// schedule as a PDF (Mardi Gras Productions). The PDF URL changes with each
// edition, so it is discovered from the page HTML at scrape time. The PDF is
// a rigid table (code, weekday, date, fair name, street segment), so events
// are parsed deterministically without a Claude pass.
const SCHEDULE_PAGE_URL = "https://nycstreetfairs.com/event-schedule/";
// The site's WAF intermittently 403s some user agents (observed: the Chrome
// UA used by other scrapers), so try a few header sets before giving up.
const HEADER_SETS: Array<Record<string, string>> = [
  {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  { "User-Agent": "PulseNYC/1.0 (https://pulse-3ed92.web.app)" },
];

async function fetchWithFallbacks(url: string): Promise<Response | null> {
  let lastStatus = 0;
  for (const headers of HEADER_SETS) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response;
      lastStatus = response.status;
      console.warn(
        `NYC Street Fairs fetch ${response.status} with UA "${headers["User-Agent"].slice(0, 40)}…": ${url}`
      );
    } catch (err) {
      console.warn(`NYC Street Fairs fetch error for ${url}:`, err);
    }
  }
  console.error(`NYC Street Fairs fetch failed (${lastStatus}): ${url}`);
  return null;
}

export function extractSchedulePdfUrl(html: string): string | null {
  // WonderPlugin PDF embed iframe: .../viewer.html?v=2&file=<pdf url>
  const iframe = html.match(/[?&]file=(https?:[^"&']+\.pdf)/i);
  if (iframe) {
    try {
      return decodeURIComponent(iframe[1]);
    } catch {
      return iframe[1];
    }
  }
  // Fallback: a schedule PDF link (the page also links price lists etc.).
  const linkPattern = /href=["'](https?:[^"']+\.pdf)["']/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    if (/schedule/i.test(match[1])) return match[1];
  }
  return null;
}

// The PDF uses Unicode modifier letters for ordinal suffixes (1ˢᵗ, 47ᵗʰ).
const SUPERSCRIPTS: Record<string, string> = {
  "ˢ": "s",
  "ᵗ": "t",
  "ʳ": "r",
  "ᵈ": "d",
  "ⁿ": "n",
  "ʰ": "h",
  "ˡ": "l",
};

export function normalizePdfText(text: string): string {
  return text
    .replace(/[ˢᵗʳᵈⁿʰˡ]/g, (ch) => SUPERSCRIPTS[ch] ?? ch)
    .replace(/[–—]/g, "-");
}

const ACRONYMS = new Set(["NYC", "USO", "WTC", "BID"]);
const SMALL_WORDS = new Set(["of", "the", "and", "from", "between", "to", "at", "on"]);

export function titleCaseFair(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      // Leave leading-digit words alone so ordinals stay "47th", not "47Th".
      if (/^\d/.test(word)) return word;
      const clean = word.replace(/[^a-z]/gi, "").toUpperCase();
      if (ACRONYMS.has(clean)) return clean;
      if (index > 0 && SMALL_WORDS.has(word)) return word;
      return word.replace(/[a-z]/, (c) => c.toUpperCase());
    })
    .join(" ");
}

function expandStreetSuffix(value: string): string {
  return value
    .replace(/\bSt\.?(?=\s|$)/gi, "Street")
    .replace(/\bAve\.?(?=\s|$)/gi, "Avenue")
    .replace(/\bPl\.?(?=\s|$)/gi, "Place")
    .replace(/\bBlvd\.?(?=\s|$)/gi, "Boulevard");
}

const WEST_SIDE_AVENUES = new Set([
  "6th avenue",
  "7th avenue",
  "8th avenue",
  "9th avenue",
  "10th avenue",
  "11th avenue",
  "12th avenue",
  "avenue of the americas",
  "columbus avenue",
  "amsterdam avenue",
  "west end avenue",
  "riverside drive",
]);
const EAST_SIDE_AVENUES = new Set([
  "1st avenue",
  "2nd avenue",
  "3rd avenue",
  "lexington avenue",
  "york avenue",
]);

// Manhattan numbered cross streets are East/West depending on which avenue
// they cross; Nominatim junction lookups need the prefix ("West 47th Street
// & 7th Avenue", not "47th Street & 7th Avenue").
function prefixManhattanCross(cross: string, mainStreet: string): string {
  if (!/^\d+(?:st|nd|rd|th) Street$/i.test(cross)) return cross;
  const main = mainStreet.toLowerCase();
  if (WEST_SIDE_AVENUES.has(main)) return `West ${cross}`;
  if (EAST_SIDE_AVENUES.has(main)) return `East ${cross}`;
  return cross;
}

export function normalizeFairLocation(rawLocation: string, borough: string): string {
  const cleaned = expandStreetSuffix(
    titleCaseFair(rawLocation.replace(/\s+/g, " ").trim()).replace(/\bSidewalk\b/gi, "").trim()
  ).replace(/\.\s*$/, "");
  const segment = cleaned.match(/^(.+?)\s+from\s+(.+?)\s*-\s*(.+)$/i);
  if (!segment) return `${cleaned}, ${borough}`;

  const street = expandStreetSuffix(segment[1].trim());
  let crossA = expandStreetSuffix(segment[2].trim());
  let crossB = expandStreetSuffix(segment[3].trim());
  // Both cross streets share a type on the grid; the PDF only prints the
  // suffix on the second one ("47th - 57th St.").
  const suffixB = crossB.match(/\b(Street|Avenue|Place|Boulevard)$/i)?.[1];
  if (suffixB && /^\d+(?:st|nd|rd|th)$/i.test(crossA)) {
    crossA = `${crossA} ${suffixB}`;
  }
  if (borough === "Manhattan") {
    crossA = prefixManhattanCross(crossA, street);
    crossB = prefixManhattanCross(crossB, street);
  }
  return `${street} between ${crossA} and ${crossB}, ${borough}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const ROW_START =
  /^L?\d{1,3}\s+(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*(.*)$/i;

interface ParsedRow {
  weekday: string;
  month: number;
  day: number;
  titleLines: string[];
  locationRaw: string;
  borough: string;
}

function to24Hour(hour: number, meridiem: string): number {
  const pm = /^p/i.test(meridiem);
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

export function parseStreetFairSchedule(text: string, nowMs: number): ScrapedEvent[] {
  const normalized = normalizePdfText(text);
  const yearMatch = normalized.match(/(\d{4})\s+EVENT SCHEDULE/i);
  const year = yearMatch ? Number(yearMatch[1]) : etDateParts(nowMs).year;

  const hoursMatch = normalized.match(
    /FROM\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s+TO\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
  );
  const startHour = hoursMatch ? to24Hour(Number(hoursMatch[1]), hoursMatch[3]) : 10;
  const startMinute = hoursMatch ? Number(hoursMatch[2] ?? 0) : 0;
  const endHour = hoursMatch ? to24Hour(Number(hoursMatch[4]), hoursMatch[6]) : 18;
  const endMinute = hoursMatch ? Number(hoursMatch[5] ?? 0) : 0;
  const hoursLabel = hoursMatch
    ? `${hoursMatch[1]}${hoursMatch[2] ? `:${hoursMatch[2]}` : ""}${hoursMatch[3].toUpperCase()} to ${hoursMatch[4]}${hoursMatch[5] ? `:${hoursMatch[5]}` : ""}${hoursMatch[6].toUpperCase()}`
    : "10AM to 6PM";

  const rows: ParsedRow[] = [];
  let current: ParsedRow | null = null;
  let pendingBorough = "";

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const rowMatch = line.match(ROW_START);
    if (rowMatch) {
      const month = MONTHS[rowMatch[2].slice(0, 4).toLowerCase()] ?? MONTHS[rowMatch[2].slice(0, 3).toLowerCase()];
      current = {
        weekday: rowMatch[1],
        month: month ?? 0,
        day: Number(rowMatch[3]),
        titleLines: rowMatch[4] ? [rowMatch[4]] : [],
        locationRaw: "",
        borough: "Manhattan",
      };
      rows.push(current);
      pendingBorough = "";
      continue;
    }
    if (!current) continue;

    const boroughMarker = line.match(/\*(BROOKLYN|QUEENS|BRONX|STATEN ISLAND|MANHATTAN)\*/i);
    if (boroughMarker) {
      pendingBorough = titleCaseFair(boroughMarker[1]);
    }

    const onIndex = line.toUpperCase().indexOf("(ON");
    if (onIndex >= 0) {
      current.locationRaw = line
        .slice(onIndex)
        .replace(/^\(ON\s+/i, "")
        .replace(/\)\s*$/, "")
        .trim();
      current.borough = pendingBorough || current.borough;
      continue;
    }

    // Title continuation lines appear before the location line; everything
    // after a location belongs to the next row or the page footer.
    if (!current.locationRaw && /^[A-Z0-9]/.test(line) && !/^\d{3}\s/.test(line)) {
      current.titleLines.push(line);
    }
  }

  const events: ScrapedEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.month || !row.locationRaw || row.titleLines.length === 0) continue;
    const title = titleCaseFair(row.titleLines.join(" "));
    const location = normalizeFairLocation(row.locationRaw, row.borough);
    const startTimestamp = etTimestamp(year, row.month, row.day, startHour, startMinute);
    const endTimestamp = etTimestamp(year, row.month, row.day, endHour, endMinute);
    if (endTimestamp < nowMs) continue;

    const dedupeKey = `${title}|${startTimestamp}|${location}`.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const monthName = new Date(Date.UTC(year, row.month - 1, 1)).toLocaleString("en-US", {
      month: "long",
      timeZone: "UTC",
    });
    const weekdayName =
      row.weekday.charAt(0).toUpperCase() + row.weekday.slice(1).toLowerCase();
    events.push({
      title,
      description: `Street fair on ${location.replace(/, [^,]+$/, "")} in ${row.borough}, from the ${year} NYC Street Fairs schedule (Mardi Gras Productions). All events are held rain or shine.`,
      startTimestamp,
      endTimestamp,
      location,
      category: "street_fair",
      sourceUrl: SCHEDULE_PAGE_URL,
      sourceName: "nycstreetfairs",
      temporalStatus: "scheduled_event",
      temporalEvidence: `Listed on the ${year} NYC Street Fairs schedule for ${weekdayName}, ${monthName} ${row.day}, ${hoursLabel}`,
    });
  }

  return events.sort((a, b) => a.startTimestamp - b.startTimestamp);
}

function ordinalUpperSuffix(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return "TH";
  switch (value % 10) {
    case 1:
      return "ST";
    case 2:
      return "ND";
    case 3:
      return "RD";
    default:
      return "TH";
  }
}

// The site's anti-bot wall (CleanTalk SpamFireWall) sometimes 403s the HTML
// pages while the uploaded PDFs stay reachable. As a fallback, probe the
// predictable upload URLs for recent editions, newest month/edition first:
// /wp-content/uploads/2026/10/2026-Vendor-Schedule-8TH-EDITION.pdf
export function buildCandidatePdfUrls(nowMs: number): string[] {
  const { year, month } = etDateParts(nowMs);
  const urls: string[] = [];
  for (let back = 0; back < 5; back++) {
    const m = month - back;
    const y = year + Math.floor((m - 1) / 12);
    const mm = String((((m - 1) % 12) + 12) % 12 + 1).padStart(2, "0");
    for (let edition = 12; edition >= 1; edition--) {
      urls.push(
        `https://nycstreetfairs.com/wp-content/uploads/${y}/${mm}/${y}-Vendor-Schedule-${edition}${ordinalUpperSuffix(edition)}-EDITION.pdf`
      );
    }
    urls.push(
      `https://nycstreetfairs.com/wp-content/uploads/${y}/${mm}/${y}-Vendor-Schedule.pdf`
    );
  }
  return urls;
}

async function fetchSchedulePdfBytes(nowMs: number): Promise<Uint8Array | null> {
  console.log(`Fetching NYC Street Fairs schedule page: ${SCHEDULE_PAGE_URL}`);
  const pageResponse = await fetchWithFallbacks(SCHEDULE_PAGE_URL);
  if (pageResponse) {
    const pdfUrl = extractSchedulePdfUrl(await pageResponse.text());
    if (pdfUrl) {
      console.log(`Downloading schedule PDF: ${pdfUrl}`);
      const pdfResponse = await fetchWithFallbacks(pdfUrl);
      if (pdfResponse) return new Uint8Array(await pdfResponse.arrayBuffer());
    } else {
      console.error("No schedule PDF URL found on NYC Street Fairs schedule page");
    }
  }

  console.warn("Falling back to probing candidate schedule PDF URLs");
  for (const candidate of buildCandidatePdfUrls(nowMs)) {
    // Missing uploads return 403 (not 404) on this host, and existing PDFs
    // answer the first header set, so probe once per candidate.
    const response = await fetch(candidate, { headers: HEADER_SETS[0] }).catch(
      () => null
    );
    if (!response?.ok) continue;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // "%PDF" magic bytes.
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      console.log(`Using probed schedule PDF: ${candidate}`);
      return bytes;
    }
  }
  return null;
}

export function createNycStreetFairsScraper(): EventSource {
  return {
    name: "nycstreetfairs",
    async scrape(): Promise<ScrapedEvent[]> {
      const bytes = await fetchSchedulePdfBytes(Date.now());
      if (!bytes) return [];
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: false });
      const fullText = Array.isArray(text) ? text.join("\n") : text;
      console.log(`Extracted ${fullText.length} chars from schedule PDF`);

      const events = parseStreetFairSchedule(fullText, Date.now());
      if (events.length === 0) {
        console.warn("No upcoming street fairs parsed from schedule PDF");
      }
      console.log(`NYC Street Fairs: ${events.length} upcoming fairs`);
      return events;
    },
  };
}
