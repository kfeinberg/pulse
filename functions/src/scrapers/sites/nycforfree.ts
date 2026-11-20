import type { EventSource, ScrapedEvent, SourceLocation } from "../base.js";
import { ExtractionCache, itemKey } from "../../services/extractionCache.js";
import { parseEventTimes, parseNewItems } from "../../services/parser.js";
import { temporalExclusionReason } from "../../services/temporalFilter.js";
import { isSpecificSourceAddress, isWithinNycViewbox, isNycForFreeEventUrl } from "../../services/geocoder.js";

const BASE_URL = "https://www.nycforfree.co/events";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};
const DETAIL_CONCURRENCY = 4;

export interface SourceOccurrence {
  date: string;
  startTime: string;
  endTime: string;
  endDate?: string;
  locationAddress?: string;
  id?: string;
}
export interface WebflowLocation {
  address: string;
  name?: string;
  borough: string;
  latitude?: number;
  longitude?: number;
}
export interface WebflowEvent {
  title: string;
  slug: string;
  description: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  address: string;
  borough: string;
  frequency: string;
  sourceCategory: string;
  recurringDays: string[];
  occurrences: SourceOccurrence[];
  locations: WebflowLocation[];
  detailUnavailable?: boolean;
}

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
}
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
    ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  };
  const codePoint = (raw: string, radix: number) => {
    const n = parseInt(raw, radix);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
  };
  return value.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, decimal: string) => codePoint(decimal, 10))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
    .replace(/\s+/g, " ").trim();
}
function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of raw.matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4]);
  }
  return attrs;
}
// A small balanced element reader, not a regex ending at the first </div>.
// Ignore script/style/comment contents so code cannot masquerade as CMS cards.
function readHtml(html: string): HtmlNode {
  const cleaned = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const root: HtmlNode = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  const tags = /<\/?[a-z][\w:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let offset = 0;
  for (const match of cleaned.matchAll(tags)) {
    stack[stack.length - 1].children.push(cleaned.slice(offset, match.index));
    offset = match.index! + match[0].length;
    const tag = /^<\/?([\w:-]+)/.exec(match[0])![1].toLowerCase();
    if (match[0].startsWith("</")) {
      const index = stack.map((node) => node.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
    } else {
      const node: HtmlNode = { tag, attrs: parseAttributes(match[0]), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!/\/>$/.test(match[0]) && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) stack.push(node);
    }
  }
  stack[stack.length - 1].children.push(cleaned.slice(offset));
  return root;
}
function nodes(root: HtmlNode): HtmlNode[] {
  return [root, ...root.children.flatMap((child) => typeof child === "string" ? [] : nodes(child))];
}
function text(node: HtmlNode): string {
  return decodeHtmlEntities(node.children.map((child) => typeof child === "string" ? child : text(child)).join(" "));
}
function fields(root: HtmlNode): Record<string, string> {
  const result: Record<string, string> = {};
  for (const node of nodes(root)) {
    const key = node.attrs["event-data"];
    if (key) {
      const value = text(node);
      if (result[key] && value && result[key] !== value) throw new Error(`Conflicting NYC for FREE field: ${key}`);
      result[key] = value || result[key] || "";
    }
  }
  return result;
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function sourceDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    parseEventTimes(value, "12:00", "13:00");
    return value;
  }
  const match = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(value);
  const month = match ? MONTHS.findIndex((name) => name === match[1].toLowerCase() || name.slice(0, 3) === match[1].toLowerCase()) + 1 : 0;
  if (!match || !month) throw new Error(`Invalid NYC for FREE date: ${value}`);
  return sourceDate(`${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`);
}
function sourceTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i.exec(value);
  if (!match) throw new Error(`Invalid NYC for FREE time: ${value}`);
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 24 || (hour === 24 && minute !== 0))) throw new Error(`Invalid NYC for FREE time: ${value}`);
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}
function parseOccurrences(raw: string, startTime: string, endTime: string): SourceOccurrence[] {
  if (!raw) return [];
  let entries: unknown;
  if (/^[{[]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : parsed.occurrences ?? parsed.dateKeys;
    } catch { throw new Error("Malformed NYC for FREE occurrences JSON"); }
  } else {
    entries = raw.split(",").map((entry) => {
      const parts = entry.trim().split("|");
      if (parts.length !== 1 && parts.length !== 3) throw new Error("Malformed NYC for FREE occurrence");
      return { date: parts[0], startTime: parts[1], endTime: parts[2] };
    });
  }
  if (!Array.isArray(entries) || !entries.length) throw new Error("Malformed NYC for FREE occurrences");
  const occurrences = entries.map((entry: unknown): SourceOccurrence => {
    const value = typeof entry === "string" ? { date: entry } : entry;
    if (!value || typeof value !== "object") throw new Error("Malformed NYC for FREE occurrence");
    const record = value as Record<string, unknown>;
    if (typeof record.date !== "string" || (record.startTime != null && typeof record.startTime !== "string") || (record.endTime != null && typeof record.endTime !== "string") || (record.endDate != null && typeof record.endDate !== "string")) throw new Error("Malformed NYC for FREE occurrence");
    if (record.locationAddress != null && typeof record.locationAddress !== "string") throw new Error("Malformed NYC for FREE occurrence location");
    if (record.id != null && (typeof record.id !== "string" || !record.id.trim())) throw new Error("Malformed NYC for FREE occurrence ID");
    const occurrence = {
      date: sourceDate(record.date),
      startTime: sourceTime((record.startTime as string) || startTime),
      endTime: sourceTime((record.endTime as string) || endTime),
      ...(record.endDate ? { endDate: sourceDate(record.endDate as string) } : {}),
      ...(record.locationAddress ? { locationAddress: (record.locationAddress as string).trim() } : {}),
      ...(record.id ? { id: (record.id as string).trim() } : {}),
    };
    parseEventTimes(occurrence.date, occurrence.startTime, occurrence.endTime, occurrence.endDate);
    return occurrence;
  });
  return [...new Map(occurrences.map((occurrence) => [JSON.stringify(occurrence), occurrence])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}
function coordinate(value: unknown): number | undefined {
  if (value == null || value === "" || (typeof value !== "number" && typeof value !== "string")) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function parseLocations(raw: string): WebflowLocation[] {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Malformed NYC for FREE locations JSON"); }
  const entries: unknown = Array.isArray(parsed) ? parsed : parsed?.locations;
  if (!Array.isArray(entries) || !entries.length) throw new Error("Malformed NYC for FREE locations");
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || typeof (entry as Record<string, unknown>).address !== "string") throw new Error("Malformed NYC for FREE location");
    const loc = entry as Record<string, unknown>;
    if (!String(loc.address).trim() || (loc.name != null && typeof loc.name !== "string") || (loc.borough != null && typeof loc.borough !== "string")) throw new Error("Malformed NYC for FREE location");
    return {
      address: String(loc.address).trim(), name: (loc.name as string) || undefined,
      borough: (loc.borough as string) || "", latitude: coordinate(loc.lat), longitude: coordinate(loc.lng ?? loc.long),
    };
  });
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function recurringDays(raw: string): string[] {
  if (!raw) return [];
  const days = raw.split(/[,;\s]+/).filter(Boolean).map((day) => WEEKDAYS.find((known) => day.toLowerCase() === known.toLowerCase() || day.toLowerCase() === `${known.toLowerCase()}day` || day.toLowerCase() === ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][WEEKDAYS.indexOf(known)]));
  if (days.some((day) => !day)) throw new Error(`Invalid NYC for FREE recurring days: ${raw}`);
  return [...new Set(days as string[])];
}
export interface CardFailure {
  slug?: string;
  error: Error;
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
function parseCard(node: HtmlNode): WebflowEvent {
  const a = node.attrs;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug)) throw new Error(`Invalid NYC for FREE slug: ${a.slug}`);
  const f = fields(node);
  const startDate = sourceDate(f["start-date"] || a["start-date"]);
  const endDate = sourceDate(f["end-date"] || a["end-date"] || startDate);
  const startTime = sourceTime(f["start-time"] || a["start-time"] || "12:00");
  const endTime = sourceTime(f["end-time"] || a["end-time"] || "23:59");
  parseEventTimes(startDate, startTime, endTime, endDate);
  const event: WebflowEvent = {
    title: a.title, slug: a.slug, description: f.description || a.description || "",
    startDate, endDate, startTime, endTime,
    address: a.address || "", borough: a.borough || "", frequency: f.frequency || a.frequency || "One-time", sourceCategory: a.category || "",
    recurringDays: recurringDays(f["recurrent-days"] || f["recurring-days"] || a["recurring-days"] || ""),
    occurrences: parseOccurrences(f.occurrences || "", startTime, endTime),
    locations: parseLocations(f.locations || ""),
  };
  if (!event.locations.length && event.address) event.locations.push({ address: event.address, borough: event.borough, name: a.place || undefined, latitude: coordinate(a.lat), longitude: coordinate(a.long) });
  return event;
}
// Every card is validated as strictly as before, but one malformed or
// conflicting card is reported on its own instead of hiding every other card.
export function readWebflowCards(html: string): { events: WebflowEvent[]; failures: CardFailure[] } {
  const events = new Map<string, WebflowEvent>();
  const conflicted = new Set<string>();
  const failures: CardFailure[] = [];
  for (const node of nodes(readHtml(html))) {
    const a = node.attrs;
    if (!a.class?.split(/\s+/).includes("w-dyn-item") || !a.title || !a.slug || !a["start-date"]) continue;
    let event: WebflowEvent;
    try {
      event = parseCard(node);
    } catch (error) {
      failures.push({ slug: a.slug, error: asError(error) });
      continue;
    }
    const previous = events.get(event.slug);
    if (previous && toText(previous) !== toText(event)) {
      failures.push({ slug: event.slug, error: new Error(`Conflicting NYC for FREE cards: ${event.slug}`) });
      conflicted.add(event.slug);
      continue;
    }
    events.set(event.slug, event);
  }
  for (const slug of conflicted) events.delete(slug);
  return { events: [...events.values()], failures };
}
export function parseWebflowEvents(html: string): WebflowEvent[] {
  const { events, failures } = readWebflowCards(html);
  if (failures.length) throw failures[0].error;
  return events;
}
function eventUrl(event: WebflowEvent): string { return `${BASE_URL}/${event.slug}`; }
// Keep every authoritative field in the exact extraction text/cache fingerprint.
export function toText(event: WebflowEvent): string {
  return `NYC for FREE source metadata v4\nDetail status: ${event.detailUnavailable ? "Detail unavailable; use only the publisher's still-listed card facts, not any redirected page content." : "Published listing metadata and any fetched details."}\nEvent: ${event.title}\nDescription: ${event.description}\nSource category: ${event.sourceCategory || "N/A"}\nFrequency: ${event.frequency}\nStart (Eastern Time): ${event.startDate} ${event.startTime}\nEnd (Eastern Time): ${event.endDate} ${event.endTime}\nRecurring weekdays: ${event.recurringDays.join(",") || "None"}\nExplicit occurrences (Eastern Time): ${JSON.stringify(event.occurrences)}\nSource locations: ${JSON.stringify(event.locations)}\nLocation: ${[event.address, event.borough].filter(Boolean).join(", ") || "NYC"}\nURL: ${eventUrl(event)}\nDo not combine independent date and location lists. Classify temporal status from source evidence; a dated permanent attraction remains excluded.`;
}
const specificAddress = isSpecificSourceAddress;
function enrichDetail(event: WebflowEvent, html: string): WebflowEvent {
  const root = readHtml(html);
  const all = nodes(root);
  const f = fields(root);
  const about = all.filter((node) => node.attrs.class?.split(/\s+/).includes("event_description-rt")).map(text).filter(Boolean).join("\n");
  const maps = all.filter((node) => node.attrs.class?.split(/\s+/).includes("event-details_map"));
  if (!about && !maps.length && !Object.keys(f).length) throw new Error(`Missing NYC for FREE detail content: ${event.slug}`);
  if (maps.length > 1) throw new Error(`Ambiguous NYC for FREE detail maps: ${event.slug}`);
  const a = maps[0]?.attrs;
  const address = a?.["data-address"] || f["location-address"] || event.address;
  const startDate = f["start-date"] ? sourceDate(f["start-date"]) : event.startDate;
  const endDate = f["end-date"] ? sourceDate(f["end-date"]) : event.endDate;
  const startTime = f["start-time"] ? sourceTime(f["start-time"]) : event.startTime;
  const endTime = f["end-time"] ? sourceTime(f["end-time"]) : event.endTime;
  parseEventTimes(startDate, startTime, endTime, endDate);
  let locations = event.locations;
  if (a?.["data-locations"] || f.locations) locations = parseLocations(a?.["data-locations"] || f.locations);
  else if (a && event.locations.length <= 1) {
    locations = [{ address, name: a["data-place"] || f["location-name"] || undefined, borough: event.borough, latitude: coordinate(a["data-lat"]), longitude: coordinate(a["data-long"]) }];
  }
  return {
    ...event, description: about || event.description, startDate, endDate, startTime, endTime, address, locations,
    frequency: f.frequency || event.frequency,
    recurringDays: f["recurrent-days"] || f["recurring-days"] ? recurringDays(f["recurrent-days"] || f["recurring-days"]) : event.recurringDays,
    occurrences: f.occurrences ? parseOccurrences(f.occurrences, startTime, endTime) : event.occurrences,
  };
}
function normalizedTitle(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function addressKey(value: string): string {
  return normalizedTitle(value).replace(/\b(?:street|avenue|boulevard|drive|road|place|east|west|north|south)\b/g, (word) => ({ street: "st", avenue: "ave", boulevard: "blvd", drive: "dr", road: "rd", place: "pl", east: "e", west: "w", north: "n", south: "s" })[word]!)
    .replace(/\b([ewns])\s*(\d)/g, "$1 $2").replace(/\b(?:usa|united states)\b/g, "").replace(/\s+/g, " ").trim();
}
function matchSource(parsed: ScrapedEvent, sources: WebflowEvent[]): WebflowEvent {
  // A supplied detail URL is authoritative identity, not a hint to ignore when
  // its title happens to share a prefix with another item.
  const url = parsed.sourceUrl;
  if (url && url !== BASE_URL && url !== `${BASE_URL}/`) {
    const trustedUrl = url.startsWith("/events/") ? `https://www.nycforfree.co${url}` : url;
    const pathname = isNycForFreeEventUrl(trustedUrl) ? new URL(trustedUrl).pathname.replace(/\/$/, "") : "";
    const matches = sources.filter((source) => pathname === `/events/${source.slug}`);
    if (matches.length === 1) return matches[0];
    throw new Error(`Unmatched NYC for FREE result URL: ${url}`);
  }
  const matches = sources.filter((source) => normalizedTitle(source.title) === normalizedTitle(parsed.title));
  if (matches.length !== 1) throw new Error(`Ambiguous or unmatched NYC for FREE title: ${parsed.title}`);
  return matches[0];
}
function streetCore(value: string): string | undefined {
  // Compare the complete house-number + street/direction core, not incidental
  // ZIP/locality formatting or a venue prefix. Never match23 inside123.
  return /(?:^|\s)(\d{1,6}(?:\s\d{1,6})?[a-z]?\s+(?:[a-z0-9]+\s+){0,10}?(?:st|ave|blvd|dr|rd|pl|lane|ln|way|broadway|pkwy|parkway|cir|circle))(?:\s|$)/.exec(addressKey(value))?.[1];
}
function boroughOf(value: string): string | undefined {
  const borough = /\b(manhattan|brooklyn|queens|(?:the )?bronx|staten island)\b/i.exec(value)?.[1].toLowerCase();
  return borough?.replace(/^the /, "");
}
function matchingLocation(parsed: ScrapedEvent, source: WebflowEvent): WebflowLocation | undefined {
  if (source.locations.length === 1) return source.locations[0];
  const key = addressKey(parsed.location);
  const core = streetCore(parsed.location);
  const borough = boroughOf(parsed.location);
  const matches = source.locations.filter((loc) => {
    const sourceBorough = boroughOf(loc.borough) || boroughOf(loc.address);
    if (borough && sourceBorough && borough !== sourceBorough) return false;
    const address = addressKey(loc.address);
    const index = key.indexOf(address);
    const containsFull = address && index >= 0 && (!key[index - 1] || key[index - 1] === " ") && (!key[index + address.length] || key[index + address.length] === " ");
    return containsFull || (core && streetCore(loc.address) === core) || (loc.name && normalizedTitle(parsed.location) === normalizedTitle(loc.name));
  });
  if (matches.length !== 1) throw new Error(`Ambiguous NYC for FREE date/location pairing: ${source.slug}`);
  return matches[0];
}
function sourcePin(loc: WebflowLocation | undefined, sourceUrl: string): SourceLocation | undefined {
  if (!loc || !specificAddress(loc.address) || loc.latitude == null || loc.longitude == null) return undefined;
  const { latitude, longitude } = loc;
  if (!isWithinNycViewbox(latitude, longitude)) return undefined;
  // The listing sometimes supplies the NYC geocoding centroid even for a
  // specific address (Jazz W11th). Preserve that address, but not its false pin.
  if (Math.abs(latitude - 40.7127753) < 0.0001 && Math.abs(longitude + 74.0059728) < 0.0001) return undefined;
  return { latitude, longitude, address: loc.address, ...(loc.name ? { placeName: loc.name } : {}), sourceUrl };
}
function datedOccurrences(source: WebflowEvent): SourceOccurrence[] {
  if (source.occurrences.length) return source.occurrences;
  if (!source.recurringDays.length || source.frequency.toLowerCase() === "continuous") return [];
  const from = Date.parse(`${source.startDate}T12:00:00Z`);
  const end = Date.parse(`${source.endDate}T12:00:00Z`);
  if ((end - from) / 86_400_000 > 550) throw new Error(`Unbounded NYC for FREE recurrence: ${source.slug}`);
  const result: SourceOccurrence[] = [];
  for (let day = from; day <= end; day += 86_400_000) {
    const date = new Date(day);
    if (source.recurringDays.includes(WEEKDAYS[date.getUTCDay()])) result.push({ date: date.toISOString().slice(0, 10), startTime: source.startTime, endTime: source.endTime });
  }
  if (!result.length) throw new Error(`Empty NYC for FREE recurrence: ${source.slug}`);
  return result;
}
function locationAliases(loc: WebflowLocation): string[] {
  const street = streetCore(loc.address)?.replace(/^\d{1,6}(?:\s\d{1,6})?[a-z]?\s+/, "");
  const road = street?.replace(/\s+(?:st|ave|blvd|dr|rd|pl|lane|ln|way|pkwy|parkway|cir|circle)$/, "");
  return [...new Set([loc.name && normalizedTitle(loc.name), street, road, boroughOf(loc.borough) || boroughOf(loc.address)].filter((alias): alias is string => !!alias))];
}
function dateMentions(content: string, date: string): { index: number; end: number }[] {
  const [year, month, day] = date.split("-").map(Number);
  const name = MONTHS[month - 1];
  const named = `\\b(?:${name}|${name.slice(0, 3)})\\s*${day}(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`;
  const numeric = `\\b${month}\\/${day}(?:\\/(20\\d{2}))?\\b`;
  const patterns = [new RegExp(named, "gi"), new RegExp(numeric, "gi"), new RegExp(`\\b${date}\\b`, "g")];
  return patterns.flatMap((pattern) => [...content.matchAll(pattern)].filter((match) => !match[1] || Number(match[1]) === year).map((match) => ({ index: match.index!, end: match.index! + match[0].length })))
    .sort((a, b) => a.index - b.index);
}
function boundOccurrences(source: WebflowEvent, occurrences: SourceOccurrence[]): SourceOccurrence[] {
  if (source.locations.length <= 1) return occurrences;
  const aliases = source.locations.map(locationAliases);
  // Only aliases identifying exactly one source location are usable. A shared
  // borough or shared brand name cannot bind a date to one of its venues.
  const unique = aliases.map((list) => list.filter((alias) => aliases.filter((other) => other.includes(alias)).length === 1));
  const segments = source.description.split(/📍|[;\n]|[.!?]\s+/);
  return occurrences.map((occurrence) => {
    if (occurrence.locationAddress) {
      const matches = source.locations.filter((loc) => addressKey(loc.address) === addressKey(occurrence.locationAddress!));
      if (matches.length !== 1) throw new Error(`Unbacked NYC for FREE occurrence location: ${source.slug}`);
      return { ...occurrence, locationAddress: matches[0].address };
    }
    const bindings = new Set<number>();
    for (const segment of segments) {
      const allDates = occurrences.flatMap((candidate) => dateMentions(segment, candidate.date));
      for (const mention of dateMentions(segment, occurrence.date)) {
        const previous = allDates.filter((candidate) => candidate.end <= mention.index).reduce((end, candidate) => Math.max(end, candidate.end), 0);
        const prefix = normalizedTitle(segment.slice(Math.max(previous, mention.index - 180), mention.index));
        const matches = unique.map((list, index) => list.some((alias) => (` ${prefix} `).includes(` ${alias} `)) ? index : -1).filter((index) => index >= 0);
        if (matches.length === 1) bindings.add(matches[0]);
        else if (matches.length > 1) throw new Error(`Ambiguous NYC for FREE source date/location binding: ${source.slug}`);
      }
    }
    if (bindings.size !== 1) throw new Error(`Unbacked NYC for FREE source date/location binding: ${source.slug}`);
    return { ...occurrence, locationAddress: source.locations[[...bindings][0]].address };
  });
}
const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
function localDate(timestamp: number): string {
  const parts = ET_DATE.formatToParts(timestamp);
  return ["year", "month", "day"].map((key) => parts.find((part) => part.type === key)!.value).join("-");
}
function locationIdentity(source: WebflowEvent, loc: WebflowLocation | undefined, actualLocation: string): string {
  if (source.locations.length === 1 && specificAddress(source.locations[0].address)) return "single";
  if (source.locations.length <= 1) {
    if (!specificAddress(actualLocation)) throw new Error(`Ambiguous NYC for FREE actual location identity: ${source.slug}`);
    return `inferred:${streetCore(actualLocation) || addressKey(actualLocation)}`;
  }
  if (!loc) throw new Error(`Missing NYC for FREE source location identity: ${source.slug}`);
  const core = streetCore(loc.address) || addressKey(loc.address);
  const clashes = source.locations.filter((candidate) => (streetCore(candidate.address) || addressKey(candidate.address)) === core);
  if (clashes.length === 1) return core;
  const borough = boroughOf(loc.borough) || boroughOf(loc.address);
  if (!borough || clashes.filter((candidate) => (boroughOf(candidate.borough) || boroughOf(candidate.address)) === borough).length !== 1) throw new Error(`Ambiguous NYC for FREE source location identity: ${source.slug}`);
  return `${core}|${borough}`;
}
function inferredSlot(template: ScrapedEvent, templates: ScrapedEvent[], source: WebflowEvent): number {
  const day = localDate(template.startTimestamp);
  const place = locationIdentity(source, matchingLocation(template, source), template.location);
  // LLM array order is not occurrence identity. Rank distinct sessions by their
  // actual clocks within this date/place; duplicate outputs share the same slot.
  const sessions = new Map<string, ScrapedEvent>();
  for (const candidate of templates) {
    if (localDate(candidate.startTimestamp) !== day ||
      locationIdentity(source, matchingLocation(candidate, source), candidate.location) !== place) continue;
    sessions.set(`${candidate.startTimestamp}|${candidate.endTimestamp}`, candidate);
  }
  const ordered = [...sessions.values()].sort((a, b) =>
    a.startTimestamp - b.startTimestamp || a.endTimestamp - b.endTimestamp);
  return ordered.findIndex((candidate) => candidate.startTimestamp === template.startTimestamp &&
    candidate.endTimestamp === template.endTimestamp);
}

function withSource(template: ScrapedEvent, source: WebflowEvent, loc: WebflowLocation | undefined, occurrence?: SourceOccurrence, continuous = false, trustPin = true, fallbackSlot = 0): ScrapedEvent {
  const result = { ...template, sourceUrl: eventUrl(source), sourceName: "nycforfree" };
  delete result.sourceLocation;
  delete result.latitude;
  delete result.longitude;
  if (loc && specificAddress(loc.address)) result.location = loc.name && !normalizedTitle(loc.address).includes(normalizedTitle(loc.name)) ? `${loc.name}, ${loc.address}` : loc.address;
  const pin = trustPin ? sourcePin(loc, result.sourceUrl) : undefined;
  if (pin) result.sourceLocation = pin;
  if (occurrence) {
    Object.assign(result, parseEventTimes(occurrence.date, occurrence.startTime, occurrence.endTime, occurrence.endDate));
    result.temporalStatus = continuous ? "limited_run" : "scheduled_event";
    result.temporalEvidence = `${template.temporalEvidence}; NYC for FREE ${occurrence.date} ${occurrence.startTime} through ${occurrence.endDate || occurrence.date} ${occurrence.endTime}`;
  }
  const date = occurrence?.date || localDate(result.startTimestamp);
  const sameDay = source.occurrences.filter((candidate) => candidate.date === date);
  const explicitSlot = occurrence ? sameDay.findIndex((candidate) => candidate.startTime === occurrence.startTime && candidate.endTime === occurrence.endTime && candidate.endDate === occurrence.endDate) : -1;
  const slot = occurrence?.id ? `id:${encodeURIComponent(occurrence.id)}` : `slot:${explicitSlot >= 0 ? explicitSlot : fallbackSlot}`;
  const identity = continuous ? "run" : `${date}|${slot}`;
  result.sourceOccurrenceId = `${source.slug}|${identity}|${locationIdentity(source, loc, result.location)}`;
  return result;
}
function cardEvents(source: WebflowEvent, templates: ScrapedEvent[]): ScrapedEvent[] {
  const output: ScrapedEvent[] = [];
  const occurrences = datedOccurrences(source);
  const single = source.locations.length === 1 && specificAddress(source.locations[0].address);
  if (source.locations.length > 1 && occurrences.length) {
    // Binding comes from literal source location/date markers, not the model
    // and never from the product of two independent arrays. One classified
    // template can recover all proven stops even if extraction omitted one
    // or attached a real location to the wrong date.
    for (const occurrence of boundOccurrences(source, occurrences)) {
      const loc = source.locations.find((candidate) => candidate.address === occurrence.locationAddress)!;
      output.push(withSource(templates[0], source, loc, occurrence));
    }
  } else if (single && occurrences.length) {
    // One classified template, one explicit location: only the source's
    // actual occurrences, including day-specific closing times.
    for (const occurrence of occurrences) {
      const template = templates.find((event) => event.startTimestamp === parseEventTimes(occurrence.date, occurrence.startTime, occurrence.endTime).startTimestamp) || templates[0];
      output.push(withSource(template, source, source.locations[0], occurrence));
    }
  } else if (single && !occurrences.length && templates.every((template) => template.temporalStatus === "limited_run") && source.endDate > source.startDate && /^(one-time|continuous)$/i.test(source.frequency)) {
    output.push(withSource(templates[0], source, source.locations[0], { date: source.startDate, endDate: source.endDate, startTime: source.startTime, endTime: source.endTime }, true));
  } else {
    for (const template of templates) {
      const loc = matchingLocation(template, source);
      let occurrence: SourceOccurrence | undefined;
      if (occurrences.length) {
        const candidates = occurrences.filter((candidate) => candidate.date === localDate(template.startTimestamp));
        const matches = candidates.length === 1 ? candidates : candidates.filter((candidate) => parseEventTimes(candidate.date, candidate.startTime, candidate.endTime).startTimestamp === template.startTimestamp);
        if (matches.length !== 1) throw new Error(`Unbacked NYC for FREE occurrence: ${source.slug}`);
        occurrence = matches[0];
        // Deliberately retain the model/source-backed pairing. Independent
        // location/date arrays are not a license to manufacture their product.
      } else if (single && templates.length === 1 && source.startDate === source.endDate) {
        occurrence = { date: source.startDate, startTime: source.startTime, endTime: source.endTime };
      }
      const trustPin = !(source.locations.length > 1 && !occurrences.length && source.endDate > source.startDate);
      const slot = inferredSlot(template, templates, source);
      output.push(withSource(template, source, loc, occurrence, false, trustPin, slot));
    }
  }
  return deduplicateEvents(output);
}
// Each source card is resolved with the same strict rules, but in isolation:
// an ambiguous card yields no events and is reported, without discarding the
// events of every other card on the listing.
export function overlayNycForFreeCards(sources: WebflowEvent[], parsed: ScrapedEvent[]): { events: ScrapedEvent[]; failures: CardFailure[] } {
  const failures: CardFailure[] = [];
  const grouped = new Map<WebflowEvent, ScrapedEvent[]>();
  for (const event of parsed) {
    try {
      const reason = temporalExclusionReason(event);
      if (reason) {
        if ((event.temporalStatus as string) === "permanent_attraction") continue;
        throw new Error(`Invalid NYC for FREE temporal extraction: ${reason}`);
      }
      const source = matchSource(event, sources);
      grouped.set(source, [...(grouped.get(source) || []), event]);
    } catch (error) {
      failures.push({ error: asError(error) });
    }
  }
  const output: ScrapedEvent[] = [];
  for (const [source, templates] of grouped) {
    try {
      output.push(...cardEvents(source, templates));
    } catch (error) {
      failures.push({ slug: source.slug, error: asError(error) });
    }
  }
  // Occurrence IDs begin with the card's unique slug, so cards cannot collide.
  return { events: output, failures };
}
export function overlayNycForFreeEvents(sources: WebflowEvent[], parsed: ScrapedEvent[]): ScrapedEvent[] {
  const { events, failures } = overlayNycForFreeCards(sources, parsed);
  if (failures.length) throw failures[0].error;
  return events;
}
function deduplicateEvents(events: ScrapedEvent[]): ScrapedEvent[] {
  const unique = new Map<string, ScrapedEvent>();
  for (const event of events) {
    const key = event.sourceOccurrenceId!;
    const previous = unique.get(key);
    if (previous && (previous.startTimestamp !== event.startTimestamp || previous.endTimestamp !== event.endTimestamp || previous.location !== event.location)) throw new Error(`Conflicting NYC for FREE occurrence identity: ${key}`);
    unique.set(key, event);
  }
  return [...unique.values()];
}
function sourceComplete(source: WebflowEvent, results: ScrapedEvent[]): boolean {
  const represented = results.filter((event) => event.sourceUrl === eventUrl(source));
  if (!represented.length) return false;
  const occurrences = datedOccurrences(source);
  if (source.locations.length > 1 && !occurrences.length && source.endDate > source.startDate) return false;
  const expected = source.locations.length > 1 ? boundOccurrences(source, occurrences) : occurrences;
  return expected.every((occurrence) => {
    const times = parseEventTimes(occurrence.date, occurrence.startTime, occurrence.endTime, occurrence.endDate);
    return represented.some((event) => event.startTimestamp === times.startTimestamp && event.endTimestamp === times.endTimestamp && (!occurrence.locationAddress || addressKey(event.location).endsWith(addressKey(occurrence.locationAddress))));
  });
}

export interface NycForFreeDependencies {
  fetch?: typeof fetch;
  extract?: NonNullable<Parameters<typeof parseNewItems>[5]>["extract"];
}
// Delay *all* staging until source identity and overlays pass. The caller alone
// commits after the pipeline succeeds. In particular, omitted items are not
// silently marked as successfully extracted.
class DeferredCache extends ExtractionCache {
  constructor(private readonly delegate: ExtractionCache) { super(delegate.sourceName); }
  override filterNew<T>(items: T[], convert: (item: T) => string) { return this.delegate.filterNew(items, convert); }
  override recordFailure(reason: string) { this.delegate.recordFailure(reason); }
}
class MissingDetailError extends Error {}

async function fetchHtml(url: string, request: typeof fetch): Promise<string> {
  const response = await request(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(20_000) });
  if (response.url && response.url !== url) {
    if (response.ok && url.startsWith(`${BASE_URL}/`) && [BASE_URL, `${BASE_URL}/`].includes(response.url)) {
      await response.body?.cancel();
      throw new MissingDetailError(`Published NYC for FREE detail redirects to its listing: ${url}`);
    }
    throw new Error(`Unexpected NYC for FREE redirect: ${response.url}`);
  }
  if (!response.ok) {
    if (url.startsWith(`${BASE_URL}/`) && [404, 410].includes(response.status)) {
      await response.body?.cancel();
      throw new MissingDetailError(`Published NYC for FREE detail is unavailable: ${url}`);
    }
    throw new Error(`NYC for FREE fetch failed (${response.status}): ${url}`);
  }
  return response.text();
}
function needsDetail(event: WebflowEvent): boolean {
  // Structured occurrences and specific locations already cover schedule/pins.
  // Otherwise truncated descriptions may conceal date/venue pairings or hours.
  return !event.locations.length || event.locations.some((loc) => !specificAddress(loc.address))
    || ((!event.occurrences.length && !event.recurringDays.length) && /(?:…|\.{3})\s*$/.test(event.description));
}
// Merge a retry's events into the first pass card by card. A card whose two
// passes disagree about one occurrence identity is dropped and reported.
function mergeCardEvents(first: ScrapedEvent[], retry: ScrapedEvent[], failures: CardFailure[]): ScrapedEvent[] {
  const bySlug = new Map<string, ScrapedEvent[]>();
  for (const event of [...first, ...retry]) {
    const slug = event.sourceOccurrenceId!.split("|")[0];
    bySlug.set(slug, [...(bySlug.get(slug) || []), event]);
  }
  const merged: ScrapedEvent[] = [];
  for (const [slug, events] of bySlug) {
    try {
      merged.push(...deduplicateEvents(events));
    } catch (error) {
      failures.push({ slug, error: asError(error) });
    }
  }
  return merged;
}
export function createNycForFreeScraper(apiKey: string, dependencies: NycForFreeDependencies = {}): EventSource {
  const request = dependencies.fetch ?? fetch;
  return {
    name: "nycforfree",
    async scrape(cache): Promise<ScrapedEvent[]> {
      const listing = readWebflowCards(await fetchHtml(BASE_URL, request));
      const failures: CardFailure[] = [...listing.failures];
      const events = listing.events;
      if (!events.length) throw failures[0]?.error ?? new Error("No NYC for FREE event cards found");
      // Refresh necessary details even when the listing is unchanged: a listing
      // cache hit must not suppress a corrected detail forever. At most four
      // requests concurrently; extraction still runs only on changed full text.
      let cursor = 0;
      const enriched: Array<WebflowEvent | null> = [...events];
      await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, events.length) }, async () => {
        while (cursor < events.length) {
          const index = cursor++;
          if (needsDetail(events[index])) {
            try {
              enriched[index] = enrichDetail(events[index], await fetchHtml(eventUrl(events[index]), request));
            } catch (error) {
              if (error instanceof MissingDetailError) {
                // The publisher still lists this card. Use only its published
                // facts, not the unrelated listing body returned by the redirect.
                // Retry enrichment next run; never delete or cache away this item.
                enriched[index] = { ...events[index], detailUnavailable: true };
                console.warn(error.message);
              } else {
                // Denied, failing or ambiguous details never get the fallback.
                // Hold back this card only; it is retried on the next run.
                enriched[index] = null;
                failures.push({ slug: events[index].slug, error: asError(error) });
              }
            }
          }
        }
      }));
      const usable = enriched.filter((event): event is WebflowEvent => event !== null);
      if (!usable.length) throw failures[0].error;
      const deferred = new DeferredCache(cache);
      const first = await parseNewItems(usable, toText, deferred, BASE_URL, apiKey, { extract: dependencies.extract });
      const firstOverlay = overlayNycForFreeCards(first.items, first.events);
      failures.push(...firstOverlay.failures);
      let results = firstOverlay.events;
      const complete = (source: WebflowEvent): boolean => {
        try {
          return sourceComplete(source, results);
        } catch {
          return false; // The overlay already reported why this card is unusable.
        }
      };
      const missing = first.items.filter((source) => !complete(source));
      if (missing.length) {
        // Retry omissions once as a separate, smaller batch. An empty result may
        // be an intentional permanent-attraction exclusion: never synthesize a
        // temporal event or indiscriminately throw on that decision. Unreturned
        // items remain unstaged, so they are not lost to the extraction cache.
        const retryCache = new ExtractionCache(cache.sourceName, { force: true });
        const retry = await parseNewItems(missing, toText, retryCache, BASE_URL, apiKey, { extract: dependencies.extract });
        const retryOverlay = overlayNycForFreeCards(retry.items, retry.events);
        failures.push(...retryOverlay.failures);
        results = mergeCardEvents(results, retryOverlay.events, failures);
      }
      // Report what is still unresolved: a card the retry completed is fine.
      const reported = [...new Map(failures.map((failure) => [`${failure.slug ?? ""}|${failure.error.message}`, failure])).values()]
        .filter((failure) => !failure.slug || !first.items.some((source) => source.slug === failure.slug && complete(source)));
      for (const failure of reported) cache.recordFailure(failure.error.message);
      // Nothing usable, nothing already extracted, and something failed: this
      // is a broken source, not a healthy empty listing.
      if (!results.length && reported.length && cache.skipped === 0) throw reported[0].error;
      cache.stage(first.items.filter((source) => !source.detailUnavailable && complete(source)).map((source) => itemKey(cache.sourceName, toText(source))));
      return results;
    },
  };
}
