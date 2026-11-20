import { createHash } from "node:crypto";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { ScrapedEvent } from "../scrapers/base.js";

const CACHE_COLLECTION = "geocodingCache";
const CACHE_VERSION = "nominatim-v1";
const NYC_VIEWBOX = "-74.2591,40.9176,-73.7004,40.4774";
const REQUEST_INTERVAL_MS = 1100;
const RATE_LIMIT_COOLDOWN_MS = 5000;

interface NominatimResult {
  osm_id: number;
  osm_type: string;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  type?: string;
  address?: {
    house_number?: string;
    road?: string;
    borough?: string;
    city?: string;
    state?: string;
    postcode?: string;
  };
}

interface ResolvedLocationFields {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  placeName: string | null;
  query: string;
}

export type ResolvedLocation = ResolvedLocationFields & (
  | { provider: "nominatim"; osmId: number; osmType: string }
  | { provider: SourcePinProvider; osmId: null; osmType: null }
);

// This is the same bounded area used for Nominatim queries. Source coordinates
// are authoritative only within it, not merely anywhere on the globe.
export function isWithinNycViewbox(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) &&
    typeof longitude === "number" && Number.isFinite(longitude) &&
    latitude >= 40.4774 && latitude <= 40.9176 &&
    longitude >= -74.2591 && longitude <= -73.7004;
}

function isHttpsUrlOn(value: unknown, hosts: string[], path: RegExp): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      hosts.includes(url.hostname) && path.test(url.pathname);
  } catch {
    return false;
  }
}

export function isNycForFreeEventUrl(value: unknown): value is string {
  return isHttpsUrlOn(value, ["www.nycforfree.co", "nycforfree.co"], /^\/events\/[a-z0-9][a-z0-9_-]*\/?$/i);
}

export function isDiceEventUrl(value: unknown): value is string {
  return isHttpsUrlOn(value, ["dice.fm", "www.dice.fm"], /^\/event\/[a-z0-9][a-z0-9_-]*\/?$/i);
}

export function isOhMyRocknessShowUrl(value: unknown): value is string {
  return isHttpsUrlOn(value, ["www.ohmyrockness.com", "ohmyrockness.com"], /^\/shows\/\d+(?:-[a-z0-9-]*)?\/?$/i);
}

// Publishers whose event pages carry the venue's own coordinates. A pin is
// trusted only when the scraper attached it from that event's own page.
export const SOURCE_PIN_PROVIDERS = {
  nycforfree: isNycForFreeEventUrl,
  dice: isDiceEventUrl,
  ohmyrockness: isOhMyRocknessShowUrl,
} as const;
export type SourcePinProvider = keyof typeof SOURCE_PIN_PROVIDERS;

export function isSourcePinProvider(value: unknown): value is SourcePinProvider {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SOURCE_PIN_PROVIDERS, value);
}

export function isTrustedSourceUrl(provider: SourcePinProvider, value: unknown): value is string {
  return SOURCE_PIN_PROVIDERS[provider](value);
}

// The viewbox is a rectangle that also covers Jersey City, Hoboken, Newark
// and the Palisades. Points west of the Hudson (north of the Battery) or of
// the Upper Bay (north of Staten Island's Kill Van Kull) are New Jersey.
const HUDSON: Array<[number, number]> = [
  [40.700, -74.025], [40.730, -74.018], [40.760, -74.008], [40.790, -73.985],
  [40.820, -73.965], [40.850, -73.950], [40.880, -73.930], [40.918, -73.915],
];
export function isWestOfHudson(latitude: number, longitude: number): boolean {
  if (latitude >= HUDSON[0][0]) {
    for (let i = 1; i < HUDSON.length; i++) {
      const [lat1, lon1] = HUDSON[i - 1];
      const [lat2, lon2] = HUDSON[i];
      if (latitude <= lat2 || i === HUDSON.length - 1) {
        const t = Math.min(1, Math.max(0, (latitude - lat1) / (lat2 - lat1)));
        return longitude < lon1 + t * (lon2 - lon1);
      }
    }
  }
  return latitude >= 40.648 && longitude < -74.045;
}

export function isWithinNyc(latitude: unknown, longitude: unknown): boolean {
  return isWithinNycViewbox(latitude, longitude) && !isWestOfHudson(latitude as number, longitude as number);
}

// Listings sometimes fill an unknown venue with the city's geocoding centroid.
export function isNycCentroid(latitude: number, longitude: number): boolean {
  return Math.abs(latitude - 40.7127753) < 0.0001 && Math.abs(longitude + 74.0059728) < 0.0001;
}

// The NYC viewbox also covers Jersey City, Hoboken and Newark, so a pin inside
// it is not proof of an NYC venue. An address that names another state, or
// whose ZIP is outside NYC's (Yonkers 107xx, Long Island 115xx, NJ 07xxx), is
// not on this map. "110" also covers some Nassau towns and is allowed.
const NYC_ZIP_PREFIXES = new Set(["100", "101", "102", "103", "104", "110", "111", "112", "113", "114", "116"]);
export function isOutsideNyc(location: string): boolean {
  // State abbreviations only in capitals, so "Ct" (court) or "Pa" never match.
  if (/,\s*(?:NJ|N\.J\.|CT|PA)\b|\b(?:NJ|CT|PA)\s+\d{5}\b/.test(location) || /\b(?:New Jersey|Connecticut|Pennsylvania)\b/i.test(location)) return true;
  const zips = [...location.matchAll(/\b(\d{5})(?:-\d{4})?\s*(?=,|$)/g)].map((match) => match[1]);
  return zips.length > 0 && zips.every((zip) => !NYC_ZIP_PREFIXES.has(zip.slice(0, 3)));
}

export function isSpecificSourceAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length < 3) return false;
  if (/^(?:n\/?a|unknown|none|not specified|location|address)$/i.test(value.trim())) return false;
  if (/\b(?:multiple|various|several|different)\s+(?:locations?|venues?|spots?|places?)\b|\b(?:locations?|venues?)\s+(?:across|throughout)\b|\b(?:tba|tbd|to be announced|to be determined|citywide|city-wide|online|virtual)\b|\b(?:see|check)\s+(?:website|site|link)\b/i.test(value)) return false;
  // Comma-free "New York NY" and borough + ZIP strings are still generic.
  const specific = normalize(value)
    .replace(/\b\d{5}(?:\s\d{4})?\b/g, "")
    .replace(/\b(?:new york city|new york|staten island|the bronx|manhattan|brooklyn|queens|bronx|nyc|ny|usa|united states)\b/g, "")
    .trim();
  return specific.length > 0;
}

function sourceAddressMatches(address: string, location: string): boolean {
  const tidy = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const requested = tidy(location);
  const source = tidy(address);
  const index = requested.indexOf(source);
  if (index < 0) return false;
  // Do not match "23 Broadway" inside "123 Broadway" or a partial name.
  const before = requested[index - 1];
  const after = requested[index + source.length];
  return (!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after));
}

function sourceLocation(event: ScrapedEvent): ResolvedLocation | null {
  // Only scraper-attached provenance is trusted. Bare model-extracted
  // latitude/longitude fields are deliberately never used as a fast path.
  const pin = event.sourceLocation;
  const provider = event.sourceName;
  if (!pin || typeof pin !== "object" || !isSourcePinProvider(provider) ||
      !isTrustedSourceUrl(provider, event.sourceUrl) || pin.sourceUrl !== event.sourceUrl ||
      !isSpecificSourceAddress(pin.address) || !isSpecificSourceAddress(event.location) ||
      !sourceAddressMatches(pin.address, event.location) ||
      !isWithinNyc(pin.latitude, pin.longitude) || isNycCentroid(pin.latitude, pin.longitude) ||
      isOutsideNyc(pin.address) || isOutsideNyc(event.location)) return null;
  if (pin.placeName !== undefined && (typeof pin.placeName !== "string" || !pin.placeName.trim())) return null;
  return {
    latitude: pin.latitude,
    longitude: pin.longitude,
    formattedAddress: pin.address.trim(),
    placeName: pin.placeName?.trim() ?? null,
    query: pin.sourceUrl,
    provider,
    osmId: null,
    osmType: null,
  };
}

function normalizeStreetDirections(location: string): string {
  const directions: Record<string, string> = { N: "North", S: "South", E: "East", W: "West" };
  return location.replace(/\b([NSEW])\s*(\d{1,3}(?:st|nd|rd|th))\b/gi,
    (_match, direction: string, street: string) => `${directions[direction.toUpperCase()]} ${street}`);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getSourceHint(sourceUrl: string): string | null {
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase();
    if (hostname.includes("bklynlibrary.org")) return "Brooklyn";
    if (hostname.includes("queenslibrary.org")) return "Queens";
  } catch {
    // An invalid source URL should not prevent normal location lookup.
  }
  return null;
}

function isGenericNycLocation(location: string): boolean {
  const genericParts = new Set([
    "new york",
    "new york city",
    "ny",
    "usa",
    "united states",
    "manhattan",
    "brooklyn",
    "queens",
    "bronx",
    "the bronx",
    "staten island",
  ]);
  const parts = location
    .split(",")
    .map((part) => normalize(part).replace(/\b\d{5}(?:\s\d{4})?\b/g, "").trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => genericParts.has(part));
}

function parseLocation(location: string): {
  placeName: string | null;
  address: string | null;
  addressOnly: boolean;
  houseNumber: string | null;
} {
  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const streetIndex = parts.findIndex((part) => /^\d{1,6}[a-z]?\b/i.test(part));
  const addressOnly = streetIndex === 0;
  const placeName =
    streetIndex > 0 ? parts.slice(0, streetIndex).join(", ") : addressOnly ? null : parts[0] || null;
  const address = streetIndex >= 0 ? parts.slice(streetIndex).join(", ") : null;
  const houseNumber = address?.match(/^\s*(\d{1,6}[a-z]?)\b/i)?.[1] ?? null;
  return { placeName, address, addressOnly, houseNumber };
}

const BOROUGH_PATTERN = /\b(Manhattan|Brooklyn|Queens|The Bronx|Bronx|Staten Island)\b/i;

// Street-segment and intersection locations (street fairs, farmers markets,
// Trick-or-Streets) have no house number for Nominatim to anchor on, and the
// raw phrasing ("X between A and B") returns nothing. Junction phrasing
// ("A & X") hits OSM junction nodes when they exist; the bare street name
// resolves to the street itself as a last-resort centroid.
export function segmentQueries(location: string): {
  junctionQueries: string[];
  streetOnlyQuery: string | null;
} {
  const none = { junctionQueries: [] as string[], streetOnlyQuery: null };
  location = normalizeStreetDirections(location);
  const boroughMatch = location.match(BOROUGH_PATTERN);
  const area = boroughMatch
    ? boroughMatch[1].replace(/^the\s+/i, "").replace(/\b\w/g, (c) => c.toUpperCase())
    : "New York";
  const suffix = `${area}, New York, NY`;

  const segment = location.match(
    /([A-Za-z0-9 .'-]+?)\s+(?:between|from)\s+([A-Za-z0-9 .'-]+?)\s+(?:and|to)\s+([A-Za-z0-9 .'-]+?)(?:,| in | on |$)/i
  );
  if (segment) {
    const street = segment[1].trim();
    const crosses = [segment[2].trim(), segment[3].trim()].filter(
      (cross) => cross && !/^dead\s+end$/i.test(cross)
    );
    if (!street) return none;
    const junctionQueries = crosses.flatMap((cross) => [
      `${cross} & ${street}, ${suffix}`,
      `${street} & ${cross}, ${suffix}`,
    ]);
    return { junctionQueries, streetOnlyQuery: `${street}, ${suffix}` };
  }

  const intersection = location.match(
    /([A-Za-z0-9 .'-]+?)\s+(&|at|and)\s+([A-Za-z0-9 .'-]+?)(?:,| in | on |$)/i
  );
  if (intersection) {
    const a = intersection[1].trim();
    const separator = intersection[2].toLowerCase();
    const b = intersection[3].trim();
    if (!a || !b || /^dead\s+end$/i.test(b)) return none;
    // "Jazz and Friends" is a venue name, not a street intersection. Only
    // add the new "and" lookup for two recognizable street names.
    const streetName = /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|place|pl|parkway|pkwy|way|broadway|bowery)\b|\b\d+(?:st|nd|rd|th)\b/i;
    if (separator === "and" && (!streetName.test(a) || !streetName.test(b))) return none;
    return {
      junctionQueries: [`${a} & ${b}, ${suffix}`, `${b} & ${a}, ${suffix}`],
      // New intersection support must not turn an unresolved junction into
      // a potentially distant street centroid.
      streetOnlyQuery: separator === "and" ? null : `${a}, ${suffix}`,
    };
  }

  return none;
}

const COUNTRY_PART = /^(?:usa|u\.s\.a\.?|u\.s\.|us|united states(?: of america)?)$/i;
// Whole location parts that only describe a unit inside a building, or that
// are stray clock times ("00:00, 21-38 44th Rd"). Nominatim cannot use them.
const UNIT_PART = /^(?:(?:\d{1,3}(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|ground|top|main|lower|upper)\s+(?:floor|fl\.?)|(?:floor|fl\.?)\s*\d{1,3}|(?:suite|ste\.?|unit|apt\.?|apartment|room|rm\.?)\s*#?\s*[\w-]+(?:\s*\([^)]*\))?|#\s*[\w-]+|(?:[\w'’.]+\s+){0,3}hearing room(?:\s*\d+)?|\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?)$/i;
// A unit written inside the street part: "199 Cook Street Suite 203".
const INLINE_UNIT = /\s+(?:suite|ste\.?|unit|apt\.?|apartment|room|rm\.?)\s*#?\s*[\w-]+|\s+#\s*[\w-]+/gi;
const STATE_TAIL = /\b(?:NY|New York)(?:\s+\d{5}(?:-\d{4})?)?\s*$/i;
const HOUSE_NUMBER = /^\d{1,6}(?:-\d{1,6})?[a-z]?\b/i;

const partKey = (part: string) => part.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const containsWords = (haystack: string, needle: string) => ` ${partKey(haystack)} `.includes(` ${partKey(needle)} `);

// Removes what makes Nominatim return nothing for an otherwise exact address:
// unit/floor/room designators, a trailing country, repeated parts and stray
// clock times. The named place and the street address are kept as written.
// After the street, a locality fragment that an earlier part already states
// is dropped too ("Brooklyn NY 11206, Brooklyn, NY 11206").
export function cleanLocation(location: string): string {
  const kept: string[] = [];
  let streetSeen = false;
  let tail: string[] = [];
  for (const raw of normalizeStreetDirections(location).replace(/\s+/g, " ").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed || COUNTRY_PART.test(trimmed) || UNIT_PART.test(trimmed)) continue;
    const isStreet = HOUSE_NUMBER.test(trimmed);
    const part = isStreet ? trimmed.replace(INLINE_UNIT, "").trim() : trimmed;
    if (!partKey(part) || kept.some((previous) => partKey(previous) === partKey(part))) continue;
    if (streetSeen && !isStreet && tail.some((previous) => containsWords(previous, part))) continue;
    if (isStreet) {
      streetSeen = true;
      tail = [];
    } else if (streetSeen) {
      tail.push(part);
    }
    kept.push(part);
  }
  return kept.join(", ");
}

// "629 West 51st St, New York, NY 10019, USA" fails once ", New York, NY" is
// appended again; only add the city when no state is present.
function withCity(query: string): string {
  return STATE_TAIL.test(query) ? query : `${query}, New York, NY`;
}

// The street part and the locality after it, without locality fragments that
// an earlier part already states ("Brooklyn NY 11206, Brooklyn, NY 11206").
function streetAddress(parts: string[], streetIndex: number): string {
  const tail: string[] = [];
  for (const part of parts.slice(streetIndex + 1)) {
    if (HOUSE_NUMBER.test(part) || tail.some((previous) => containsWords(previous, part))) continue;
    tail.push(part);
  }
  return [parts[streetIndex], ...tail].join(", ");
}

const NAME_STOPWORDS = new Set(["the", "of", "and", "at", "in", "on", "nyc", "new", "york", "ny"]);
const nameWords = (value: string) => partKey(value).split(" ").filter((word) => word && !NAME_STOPWORDS.has(word));

// Last-resort lookups by the bare place name, which Nominatim matches far
// better than "Name, Neighborhood, Borough": "Frick Collection" rather than
// "The Frick Collection, Upper East Side", "David Rubenstein Atrium" rather
// than "Lincoln Center's David Rubenstein Atrium". One-word names are too
// ambiguous to look up without an address.
export function placeNameVariants(placeName: string): string[] {
  const first = placeName.split(",")[0].trim();
  const strip = (value: string) => value.replace(/^the\s+/i, "").trim();
  const distinctive = (value: string, minWords: number) =>
    nameWords(value).length >= minWords || (/\d/.test(value) && nameWords(value).length >= 1);
  const variants: string[] = [];
  if (distinctive(strip(first), 2)) variants.push(strip(first));
  // "X's Y": Y alone must still be specific ("Rudy's Bar & Grill" is not).
  const possessive = /^[^'’]{2,60}['’]s\s+(.+)$/.exec(first)?.[1];
  if (possessive && distinctive(strip(possessive), 3)) variants.push(strip(possessive));
  const head = first.split(/\s*:\s*|\s+[-–—|]\s+/)[0];
  if (head && head !== first && distinctive(strip(head), 2)) variants.push(strip(head));
  return [...new Set(variants)].filter((variant) => !isGenericNycLocation(variant)).slice(0, 2);
}

// A bare-name result must actually carry every distinctive word of the name.
function nameMatches(result: NominatimResult, requested: string): boolean {
  const resultWords = new Set(nameWords(result.name || ""));
  const words = nameWords(requested);
  return words.length > 0 && words.every((word) => resultWords.has(word));
}

interface GeocodeQuery {
  q: string;
  // Only results whose name matches this place are acceptable.
  requireName?: string;
}

function buildQueries(event: ScrapedEvent): GeocodeQuery[] {
  const location = cleanLocation(event.location) || normalizeStreetDirections(event.location).replace(/\s+/g, " ").trim();
  const parts = location.split(",").map((part) => part.trim()).filter(Boolean);
  const { placeName } = parseLocation(location);
  const streetIndex = parts.findIndex((part) => HOUSE_NUMBER.test(part));
  const address = streetIndex >= 0 ? streetAddress(parts, streetIndex) : null;
  const sourceHint = getSourceHint(event.sourceUrl);
  const { junctionQueries, streetOnlyQuery } = segmentQueries(location);
  const queries: Array<GeocodeQuery | null> = [
    ...junctionQueries.map((q) => ({ q })),
    sourceHint ? { q: `${location}, ${sourceHint}, NY` } : null,
    { q: withCity(location) },
    // An exact street address outranks a lookup by the venue's name alone,
    // which can return a same-named place elsewhere in the city.
    address ? { q: withCity(address) } : null,
    placeName && sourceHint ? { q: `${placeName}, ${sourceHint}, NY` } : null,
    placeName ? { q: `${placeName}, New York, NY` } : null,
    ...(!address && placeName ? placeNameVariants(placeName).map((variant) => ({ q: variant, requireName: variant })) : []),
    streetOnlyQuery ? { q: streetOnlyQuery } : null,
  ];
  const seen = new Set<string>();
  return queries.filter((query): query is GeocodeQuery => {
    if (!query) return false;
    query.q = query.q.replace(/\s+/g, " ").trim();
    if (seen.has(query.q)) return false;
    seen.add(query.q);
    return true;
  });
}

function scoreResult(
  result: NominatimResult,
  index: number,
  event: ScrapedEvent,
  query: string
): number {
  const { placeName, addressOnly, houseNumber } = parseLocation(event.location);
  const sourceHint = getSourceHint(event.sourceUrl);
  const resultName = normalize(result.name || "");
  const displayName = normalize(result.display_name);
  const type = normalize(result.type || "");
  let score = -index;

  if (sourceHint && displayName.includes(normalize(sourceHint))) score += 40;

  if (houseNumber) {
    const resultHouseNumber = result.address?.house_number?.toLowerCase();
    if (resultHouseNumber === houseNumber.toLowerCase()) score += 120;
    else if (new RegExp(`\\b${houseNumber}\\b`, "i").test(result.display_name)) score += 90;
    else score -= 120;
  }

  if (addressOnly) {
    if (["house", "building", "residential"].includes(type)) score += 50;
    if (result.name) score -= 10;
  }

  if (placeName) {
    const requestedName = normalize(placeName);
    if (resultName === requestedName) score += 120;
    else if (resultName.includes(requestedName) || requestedName.includes(resultName)) score += 75;

    const requestedWords = requestedName.split(" ").filter((word) => word.length > 2);
    const matchingWords = requestedWords.filter((word) => resultName.includes(word)).length;
    score += matchingWords * 12;

    if (requestedName.includes("library")) {
      if (type === "library") score += 100;
      if (type.includes("parking")) score -= 100;
    }
  }

  if (type.includes("parking")) score -= 30;
  if (normalize(query).includes("brooklyn") && displayName.includes("brooklyn")) score += 20;

  return score;
}

export class RateLimitedError extends Error {
  constructor(status: number) {
    super(`Nominatim returned ${status}`);
    this.name = "RateLimitedError";
  }
}

export interface GeocoderDeps {
  db?: Firestore;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function reserveNominatimRequest(db: Firestore, nowMs: number): Promise<number> {
  const ref = db.collection("_pipelineRateLimits").doc("nominatim");
  return db.runTransaction(async (tx) => {
    const raw = (await tx.get(ref)).data()?.requestAtMs;
    const previous = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    const requestAtMs = Math.max(nowMs, previous + REQUEST_INTERVAL_MS);
    tx.set(ref, { requestAtMs });
    return requestAtMs;
  });
}

async function search(query: string, db: Firestore, deps: GeocoderDeps): Promise<NominatimResult[]> {
  // One shared reservation survives replica changes and covers *requests*,
  // not just queue dispatches (one task can try several fallback queries).
  const now = deps.now ?? Date.now;
  const requestAt = await reserveNominatimRequest(db, now());
  const waitMs = requestAt - now();
  if (waitMs > 0) await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(waitMs);

  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    limit: "5",
    countrycodes: "us",
    viewbox: NYC_VIEWBOX,
    bounded: "1",
    dedupe: "1",
  });
  try {
    const response = await (deps.fetch ?? fetch)(`https://nominatim.openstreetmap.org/search?${params}`, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "PulseNYC/1.0 (https://pulse-3ed92.web.app)",
        "Accept-Language": "en-US,en",
      },
    });
    if (!response.ok) {
      if (response.status === 429) throw new RateLimitedError(response.status);
      throw new Error(`Nominatim returned ${response.status}`);
    }
    return (await response.json()) as NominatimResult[];
  } finally {
    // A slow reservation can leave its nominal timestamp behind the actual
    // dispatch. Keep the global stage lease through this post-response/body
    // cooldown, covering fallback queries and handoff to a fresh instance.
    await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(REQUEST_INTERVAL_MS);
  }
}

// Thrown when no query found the place and at least one lookup failed with an
// error (rate limit, network, server error) rather than returning no results,
// so the place may still exist and the event is worth retrying later.
export class LocationLookupError extends Error {
  constructor(location: string, cause: unknown) {
    super(`Location lookup failed for "${location}": ${String(cause)}`);
    this.name = "LocationLookupError";
  }
}

function cacheId(event: ScrapedEvent): string {
  const key = `${CACHE_VERSION}|${normalize(event.location)}|${getSourceHint(event.sourceUrl) || ""}`;
  return createHash("sha256").update(key).digest("hex");
}

export async function resolveEventLocation(
  event: ScrapedEvent,
  deps: GeocoderDeps = {}
): Promise<ResolvedLocation | null> {
  if (!event.location.trim()) return null;
  if (isOutsideNyc(event.location)) {
    console.warn(`Skipped location outside NYC: "${event.location}"`);
    return null;
  }
  // A validated, event-specific publisher pin outranks stale OSM cache data
  // and needs neither a cache write nor a Nominatim request reservation.
  const sourcePin = sourceLocation(event);
  if (sourcePin) return sourcePin;
  if (isGenericNycLocation(event.location)) {
    console.warn(`Skipped generic NYC location without a specific place: "${event.location}"`);
    return null;
  }

  const db = deps.db ?? getFirestore();
  const cacheRef = db.collection(CACHE_COLLECTION).doc(cacheId(event));
  const cached = await cacheRef.get();
  if (cached.exists) {
    const data = cached.data() as ResolvedLocation;
    // An older entry may point across the Hudson; look that place up again.
    if (isWithinNyc(data.latitude, data.longitude)) {
      console.log(`Geocoding cache hit for "${event.location}"`);
      return data;
    }
  }

  let lookupError: unknown = null;
  for (const { q: query, requireName } of buildQueries(event)) {
    try {
      // The bounded viewbox reaches into New Jersey; keep New York results only.
      const found = (await search(query, db, deps)).filter((result) =>
        (!result.address?.state || result.address.state === "New York") && isWithinNyc(Number(result.lat), Number(result.lon)));
      const results = requireName ? found.filter((result) => nameMatches(result, requireName)) : found;
      if (results.length === 0) continue;

      const ranked = results
        .map((result, index) => ({ result, score: scoreResult(result, index, event, query) }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0].result;
      const latitude = Number(best.lat);
      const longitude = Number(best.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

      const resolved: ResolvedLocation = {
        latitude,
        longitude,
        formattedAddress: best.display_name,
        placeName: best.name || null,
        query,
        provider: "nominatim",
        osmId: best.osm_id,
        osmType: best.osm_type,
      };
      await cacheRef.set({
        ...resolved,
        originalLocation: event.location,
        sourceUrl: event.sourceUrl,
        createdAt: Timestamp.now(),
      });
      console.log(
        `Resolved "${event.location}" → "${resolved.formattedAddress}" (${latitude}, ${longitude})`
      );
      return resolved;
    } catch (error) {
      console.warn(`Location lookup failed for "${query}":`, error);
      lookupError = error;
      if (error instanceof RateLimitedError) {
        // Nominatim is throttling this egress IP (e.g. overlapping scrape
        // invocations). Hammering the remaining fallback queries only
        // extends the block; give up on this event and pause so subsequent
        // events back off instead of each issuing a full query storm.
        console.warn("Nominatim rate limited; skipping remaining queries for this event");
        await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(RATE_LIMIT_COOLDOWN_MS);
        break;
      }
    }
  }

  if (lookupError) {
    throw new LocationLookupError(event.location, lookupError);
  }
  console.warn(`No exact NYC location found for "${event.location}"; event will not get a pin`);
  return null;
}
