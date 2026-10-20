import { EventCategory, EventSource, ScrapedEvent } from "../base.js";
import type { ExtractionCache } from "../../services/extractionCache.js";
import { parseNewItems, stripHtml } from "../../services/parser.js";
import {
  addDays,
  etDateParts,
  etTimestamp,
  etWeekday,
  formatUsDate,
  type DateParts,
} from "../../services/etTime.js";

// https://www.nyc.gov/main/events/ is a JS app over the city's calendar API.
// The page itself fetches the API gateway and its public browser subscription
// key from www.nyc.gov endpoints; we do the same at scrape time (never
// hardcode the key, so rotation does not break this source), then query the
// same calendar/search service the site uses.
const EVENTS_PAGE_URL = "https://www.nyc.gov/main/events/";
const GATEWAY_URL = "https://www.nyc.gov/bin/nyc/gateway.json";
const KEY_URL = "https://www.nyc.gov/bin/nyc/sc.ec.json";
const DEFAULT_GATEWAY = "https://api.nyc.gov/";
// Pulse only surfaces the next 3 days, like the Dice source's today+2 window.
const WINDOW_DAYS = 3;
// Scoped to street-level events (markets, fairs, parades, block festivals);
// the full calendar is ~110 events/day dominated by Parks classes.
const NYC_CATEGORY = "Street and Neighborhood";
const MAX_PAGES = 30;
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: EVENTS_PAGE_URL,
};

export interface NycGovEventItem {
  id: number;
  sequence: number;
  name: string;
  desc?: string;
  shortDesc?: string;
  startDate: string;
  endDate?: string;
  allDay?: boolean;
  canceled?: boolean;
  permalink: string;
  website?: string;
  address?: string;
  boroughs?: string[];
  categories?: string;
}

interface NycGovSearchResponse {
  items?: NycGovEventItem[];
  pagination?: { numPages?: number; totalItems?: number };
}

export const BOROUGH_NAMES: Record<string, string> = {
  Mn: "Manhattan",
  Bk: "Brooklyn",
  Bx: "Bronx",
  Qn: "Queens",
  SI: "Staten Island",
};

export function boroughName(item: NycGovEventItem): string {
  for (const code of item.boroughs ?? []) {
    const name = BOROUGH_NAMES[code];
    if (name) return name;
  }
  return "";
}

const FARMERS_MARKET_TITLE = /farmers?\s*markets?|green\s*markets?|farm\s*stands?/i;
const STREET_FAIR_TITLE = /street\s+fair|street\s+festival|block\s+party|flea\s+market/i;
// SAPO permit types surfaced in shortDesc for Street and Neighborhood items.
const STREET_FAIR_TYPES = new Set([
  "street festival",
  "single block festival",
  "sidewalk sale",
]);

export function isFarmersMarket(item: NycGovEventItem): boolean {
  return (
    FARMERS_MARKET_TITLE.test(item.name) ||
    (item.shortDesc ?? "").trim().toLowerCase() === "farmers market"
  );
}

export function forcedCategory(item: NycGovEventItem): EventCategory | undefined {
  if (isFarmersMarket(item)) return "farmers_market";
  const type = (item.shortDesc ?? "").trim().toLowerCase();
  if (STREET_FAIR_TYPES.has(type) || STREET_FAIR_TITLE.test(item.name)) {
    return "street_fair";
  }
  return undefined;
}

const WEEKDAY_PATTERNS: Array<[string, RegExp]> = [
  ["sunday", /\bsundays?\b/i],
  ["monday", /\bmondays?\b/i],
  ["tuesday", /\b(?:tuesdays?|tues\.?)\b/i],
  ["wednesday", /\bwednesdays?\b/i],
  ["thursday", /\b(?:thursdays?|thurs\.?)\b/i],
  ["friday", /\bfridays?\b/i],
  ["saturday", /\bsaturdays?\b/i],
];

export function titleWeekdays(title: string): string[] {
  return WEEKDAY_PATTERNS.filter(([, pattern]) => pattern.test(title)).map(
    ([day]) => day
  );
}

// The SAPO feed expands weekly market permits to a daily instance (e.g.
// "Inwood Greenmarket Saturday" is listed on Wednesdays). When a market's
// title names its actual weekday(s), only keep instances on those days.
// Markets with no weekday in the title are kept as listed.
export function passesWeekdayFilter(item: NycGovEventItem): boolean {
  if (!isFarmersMarket(item)) return true;
  const weekdays = titleWeekdays(item.name);
  if (weekdays.length === 0) return true;
  const startMs = Date.parse(item.startDate);
  if (!Number.isFinite(startMs)) return false;
  return weekdays.includes(etWeekday(startMs).toLowerCase());
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

const SMALL_WORDS = new Set(["between", "and", "to", "from", "at", "on", "in", "of", "the"]);
const STREET_SUFFIXES = new Set([
  "street",
  "avenue",
  "boulevard",
  "place",
  "road",
  "drive",
  "parkway",
  "terrace",
  "lane",
  "court",
]);

// SAPO addresses arrive SHOUTING with bare street numbers, e.g.
// " 2 AVENUE between EAST   32 STREET and EAST   33 STREET  Manhattan".
// Title-case them and ordinalize numeric street names ("2nd Avenue between
// East 32nd Street and East 33rd Street") so they display well and the
// geocoder's segment queries match OSM street names. Mixed-case addresses
// (park names etc.) are left alone apart from whitespace.
export function normalizeSapoAddress(item: NycGovEventItem): string {
  let address = (item.address ?? "").replace(/\s+/g, " ").trim();
  if (!address) return boroughName(item);

  // SAPO appends the borough in title case ("… EAST 33 STREET  Manhattan");
  // strip it before the all-caps check and re-append it with a comma.
  let borough = boroughName(item);
  const trailingBorough = address.match(
    /[\s,]+(Manhattan|Brooklyn|Queens|The Bronx|Bronx|Staten Island)\s*$/i
  );
  if (trailingBorough) {
    address = address.slice(0, trailingBorough.index).trim();
    if (!borough) borough = trailingBorough[1].replace(/^the\s+/i, "");
  }

  // SAPO shouts street names but leaves "between"/"and" lowercase, so use a
  // ratio rather than requiring every letter to be uppercase.
  const letters = address.replace(/[^A-Za-z]/g, "");
  const upperCount = (address.match(/[A-Z]/g) ?? []).length;
  const isMostlyUpper = letters.length > 0 && upperCount / letters.length >= 0.5;
  if (isMostlyUpper) {
    const words = address.split(" ");
    address = words
      .map((word, index) => {
        const lower = word.toLowerCase();
        const next = (words[index + 1] ?? "").toLowerCase();
        if (/^\d+$/.test(word) && STREET_SUFFIXES.has(next)) {
          return ordinal(Number(word));
        }
        if (index > 0 && SMALL_WORDS.has(lower)) return lower;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join(" ");
  }

  return borough ? `${address}, ${borough}` : address;
}

export function detailUrl(item: NycGovEventItem): string {
  const slug = item.permalink?.split("/events/")[1]?.split("/")[0];
  if (!slug || item.id == null || item.sequence == null) {
    return item.permalink || EVENTS_PAGE_URL;
  }
  return `${EVENTS_PAGE_URL}?permalinkName=${encodeURIComponent(slug)}&id=${item.id}&sequence=${item.sequence}`;
}

export function buildSearchUrl(
  gateway: string,
  start: DateParts,
  end: DateParts,
  pageNumber: number
): string {
  const params = new URLSearchParams({
    agency: "nyc_gov",
    categoryOperator: "OR",
    sort: "DATE",
    categories: NYC_CATEGORY,
    startDate: `${formatUsDate(start)} 12:00 am`,
    endDate: `${formatUsDate(end)} 11:59 pm`,
    pageNumber: String(pageNumber),
  });
  return `${gateway.replace(/\/?$/, "/")}calendar/search?${params}`;
}

export function cleanDescription(item: NycGovEventItem): string {
  const stripped = stripHtml(item.desc ?? "")
    .replace(/Learn about related[^.]*street closures/gi, "")
    .replace(/Visit the NYC Street Closures Map/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const short = (item.shortDesc ?? "").trim();
  const description = stripped && stripped !== short ? stripped : short;
  return description.slice(0, 500);
}

function formatET(ms: number): string {
  const s = new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return s.replace(/\b24:/, "00:");
}

export function itemToText(item: NycGovEventItem): string {
  const startMs = Date.parse(item.startDate);
  const endMs = item.endDate ? Date.parse(item.endDate) : NaN;
  return (
    `Event: ${item.name.replace(/\\\//g, "/").replace(/\s+/g, " ").trim()}\n` +
    `Description: ${cleanDescription(item) || "N/A"}\n` +
    `NYC category: ${item.categories ?? NYC_CATEGORY}\n` +
    `Source type: ${item.shortDesc ?? "N/A"}\n` +
    `Start (Eastern Time): ${Number.isFinite(startMs) ? formatET(startMs) : item.startDate}\n` +
    `End (Eastern Time): ${Number.isFinite(endMs) ? formatET(endMs) : "unknown"}\n` +
    `Location: ${normalizeSapoAddress(item) || "NYC"}\n` +
    `URL: ${detailUrl(item)}`
  );
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers: { ...FETCH_HEADERS, ...headers } });
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}): ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchApiConfig(): Promise<{ gateway: string; subscriptionKey: string }> {
  const [gatewayResult, keyResult] = await Promise.allSettled([
    fetchJson<{ API_GATEWAY?: string }>(GATEWAY_URL),
    fetchJson<{ API_KEY_EVENT_CAL?: string }>(KEY_URL),
  ]);
  const gateway =
    gatewayResult.status === "fulfilled" && gatewayResult.value.API_GATEWAY
      ? gatewayResult.value.API_GATEWAY
      : DEFAULT_GATEWAY;
  const subscriptionKey =
    keyResult.status === "fulfilled" ? keyResult.value.API_KEY_EVENT_CAL : undefined;
  if (!subscriptionKey) {
    throw new Error("Could not obtain NYC events API subscription key");
  }
  return { gateway, subscriptionKey };
}

// Fetches the next WINDOW_DAYS of NYC.gov calendar items in our category and
// applies the deterministic filters (canceled, dupes, market weekdays).
// Exported so the pre-Claude stage can be inspected on its own.
export async function fetchNycGovItems(nowMs: number): Promise<NycGovEventItem[]> {
  const { gateway, subscriptionKey } = await fetchApiConfig();
  const start = etDateParts(nowMs);
  const end = addDays(start, WINDOW_DAYS - 1);
  console.log(
    `Fetching NYC.gov ${NYC_CATEGORY} events ${formatUsDate(start)} to ${formatUsDate(end)}`
  );

  const items: NycGovEventItem[] = [];
  let page = 1;
  let numPages = 1;
  while (page <= numPages && page <= MAX_PAGES) {
    const url = buildSearchUrl(gateway, start, end, page);
    const data = await fetchJson<NycGovSearchResponse>(url, {
      "Ocp-Apim-Subscription-Key": subscriptionKey,
      "Content-Type": "application/json",
    });
    items.push(...(data.items ?? []));
    numPages = data.pagination?.numPages ?? page;
    console.log(
      `NYC.gov page ${page}/${numPages}: ${data.items?.length ?? 0} items (${items.length} total)`
    );
    page++;
  }

  const seen = new Set<string>();
  const usable = items.filter((item) => {
    if (!item.name?.trim() || !Number.isFinite(Date.parse(item.startDate))) return false;
    if (item.canceled || /^canceled\b/i.test(item.name.trim())) return false;
    const key = `${item.id}:${item.sequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const weekdayFiltered = usable.filter(passesWeekdayFilter);
  console.log(
    `NYC.gov: ${items.length} listed, ${usable.length} usable, ` +
      `${weekdayFiltered.length} after market weekday filter ` +
      `(${usable.length - weekdayFiltered.length} wrong-weekday market instances dropped)`
  );
  return weekdayFiltered;
}

export function createNycGovScraper(apiKey: string): EventSource {
  return {
    name: "nycgov",
    async scrape(cache: ExtractionCache): Promise<ScrapedEvent[]> {
      const nowMs = Date.now();
      const weekdayFiltered = await fetchNycGovItems(nowMs);
      if (weekdayFiltered.length === 0) return [];

      // Step 3: one Claude pass per ET calendar day (categorization + the
      // temporal gate), then overlay exact source data like Dice/Posh.
      const byDay = new Map<string, NycGovEventItem[]>();
      for (const item of weekdayFiltered) {
        const day = formatUsDate(etDateParts(Date.parse(item.startDate)));
        const group = byDay.get(day) ?? [];
        group.push(item);
        byDay.set(day, group);
      }

      const results: ScrapedEvent[] = [];
      for (const [day, dayItems] of byDay) {
        const { items: sentItems, events: parsed } = await parseNewItems(
          dayItems,
          itemToText,
          cache,
          EVENTS_PAGE_URL,
          apiKey
        );
        console.log(`NYC.gov ${day}: Claude extracted ${parsed.length} events`);

        const used = new Set<NycGovEventItem>();
        for (const event of parsed) {
          const parsedTitle = normalizeTitle(event.title);
          const match = sentItems.find((item) => {
            if (used.has(item)) return false;
            const sourceTitle = normalizeTitle(item.name);
            return (
              parsedTitle.includes(sourceTitle.slice(0, 25)) ||
              sourceTitle.includes(parsedTitle.slice(0, 25))
            );
          });
          if (!match) {
            console.warn(`Discarding unmatched NYC.gov extraction: "${event.title}"`);
            continue;
          }
          used.add(match);

          const startMs = Date.parse(match.startDate);
          let endMs = match.endDate ? Date.parse(match.endDate) : NaN;
          // Some SAPO items carry end == start instead of a real end time.
          if (!Number.isFinite(endMs) || endMs <= startMs) {
            const parts = etDateParts(startMs);
            endMs = etTimestamp(parts.year, parts.month, parts.day, 23, 59);
          }
          event.startTimestamp = startMs;
          event.endTimestamp = endMs;
          event.sourceUrl = detailUrl(match);
          event.sourceName = "nycgov";

          const forced = forcedCategory(match);
          if (forced) event.category = forced;

          // Restore the source location when it is a concrete street segment
          // or street address; otherwise (park permit areas etc.) keep the
          // location Claude normalized.
          const sourceLocation = normalizeSapoAddress(match);
          if (/\bbetween\b/i.test(sourceLocation) || /^\d+(-\d+)?\s/.test(sourceLocation)) {
            event.location = sourceLocation;
          }

          if (event.endTimestamp >= nowMs) results.push(event);
        }
      }

      console.log(`NYC.gov: returning ${results.length} upcoming events`);
      return results;
    },
  };
}
