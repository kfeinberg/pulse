import { createHash } from "node:crypto";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { ScrapedEvent } from "../scrapers/base.js";

const CACHE_COLLECTION = "geocodingCache";
const CACHE_VERSION = "nominatim-v1";
const NYC_VIEWBOX = "-74.2591,40.9176,-73.7004,40.4774";
const REQUEST_INTERVAL_MS = 1100;
const RATE_LIMIT_COOLDOWN_MS = 5000;

let lastRequestAt = 0;

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

export interface ResolvedLocation {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  placeName: string | null;
  query: string;
  provider: "nominatim";
  osmId: number;
  osmType: string;
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
    /([A-Za-z0-9 .'-]+?)\s+(?:&|at)\s+([A-Za-z0-9 .'-]+?)(?:,| in | on |$)/i
  );
  if (intersection) {
    const a = intersection[1].trim();
    const b = intersection[2].trim();
    if (!a || !b || /^dead\s+end$/i.test(b)) return none;
    return {
      junctionQueries: [`${a} & ${b}, ${suffix}`, `${b} & ${a}, ${suffix}`],
      streetOnlyQuery: `${a}, ${suffix}`,
    };
  }

  return none;
}

function buildQueries(event: ScrapedEvent): string[] {
  const location = event.location.replace(/\s+/g, " ").trim();
  const { placeName, address } = parseLocation(location);
  const sourceHint = getSourceHint(event.sourceUrl);
  const { junctionQueries, streetOnlyQuery } = segmentQueries(location);
  const queries = [
    ...junctionQueries,
    sourceHint ? `${location}, ${sourceHint}, NY` : null,
    `${location}, New York, NY`,
    placeName && sourceHint ? `${placeName}, ${sourceHint}, NY` : null,
    placeName ? `${placeName}, New York, NY` : null,
    address ? `${address}, New York, NY` : null,
    streetOnlyQuery,
  ].filter((query): query is string => Boolean(query));

  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()))];
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

async function search(query: string): Promise<NominatimResult[]> {
  const waitMs = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestAt = Date.now();

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
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: {
      "User-Agent": "PulseNYC/1.0 (https://pulse-3ed92.web.app)",
      "Accept-Language": "en-US,en",
    },
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new RateLimitedError(response.status);
    }
    throw new Error(`Nominatim returned ${response.status}`);
  }
  return (await response.json()) as NominatimResult[];
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
  event: ScrapedEvent
): Promise<ResolvedLocation | null> {
  if (!event.location.trim()) return null;
  if (isGenericNycLocation(event.location)) {
    console.warn(`Skipped generic NYC location without a specific place: "${event.location}"`);
    return null;
  }

  const db = getFirestore();
  const cacheRef = db.collection(CACHE_COLLECTION).doc(cacheId(event));
  const cached = await cacheRef.get();
  if (cached.exists) {
    const data = cached.data() as ResolvedLocation;
    console.log(`Geocoding cache hit for "${event.location}"`);
    return data;
  }

  let lookupError: unknown = null;
  for (const query of buildQueries(event)) {
    try {
      const results = await search(query);
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
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_COOLDOWN_MS));
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
