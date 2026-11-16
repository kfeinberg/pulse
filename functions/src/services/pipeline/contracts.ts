import { EVENT_CATEGORIES, type ScrapedEvent } from "../../scrapers/base.js";
import type { ResolvedLocation } from "../geocoder.js";

// Schema checks run at every handoff between pipeline stages. A stage that
// receives input violating its contract quarantines it with the violations
// instead of passing bad data downstream.

const TEMPORAL_STATUSES = ["scheduled_event", "limited_run"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTimestamp(value: unknown): value is number {
  // Firestore Timestamp supports years 0001–9999, less than Date's full range.
  return isFiniteNumber(value) && value >= Date.parse("0001-01-01T00:00:00Z") && value <= Date.parse("9999-12-31T23:59:59.999Z");
}

export function scrapedEventViolations(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["event is not an object"];
  const event = value as Record<string, unknown>;
  const violations: string[] = [];

  if (!isNonEmptyString(event.title)) violations.push("title is missing");
  if (typeof event.description !== "string") violations.push("description is not a string");
  if (!isNonEmptyString(event.location)) violations.push("location is missing");
  if (!isNonEmptyString(event.sourceName)) violations.push("sourceName is missing");
  if (typeof event.sourceUrl !== "string") violations.push("sourceUrl is not a string");

  if (!isValidTimestamp(event.startTimestamp)) violations.push("startTimestamp is not a valid date");
  if (!isValidTimestamp(event.endTimestamp)) violations.push("endTimestamp is not a valid date");
  if (
    isFiniteNumber(event.startTimestamp) &&
    isFiniteNumber(event.endTimestamp) &&
    event.endTimestamp < event.startTimestamp
  ) {
    violations.push("endTimestamp is before startTimestamp");
  }

  if (event.category !== undefined && !(EVENT_CATEGORIES as readonly unknown[]).includes(event.category)) {
    violations.push(`unknown category "${String(event.category)}"`);
  }
  if (!TEMPORAL_STATUSES.includes(event.temporalStatus as string)) {
    violations.push(`temporalStatus "${String(event.temporalStatus)}" is not time-bounded`);
  }
  if (!isNonEmptyString(event.temporalEvidence)) violations.push("temporalEvidence is missing");

  for (const key of ["latitude", "longitude"] as const) {
    if (event[key] !== undefined && !isFiniteNumber(event[key])) {
      violations.push(`${key} is not a number`);
    }
  }
  return violations;
}

export function isScrapedEvent(value: unknown): value is ScrapedEvent {
  return scrapedEventViolations(value).length === 0;
}

export function resolvedLocationViolations(value: unknown): string[] {
  if (value === null) return [];
  if (!value || typeof value !== "object") return ["location is not an object"];
  const geo = value as Record<string, unknown>;
  const violations: string[] = [];
  if (!isFiniteNumber(geo.latitude) || Math.abs(geo.latitude) > 90) violations.push("latitude is invalid");
  if (!isFiniteNumber(geo.longitude) || Math.abs(geo.longitude) > 180) violations.push("longitude is invalid");
  if (!isNonEmptyString(geo.formattedAddress)) violations.push("formattedAddress is missing");
  if (geo.provider !== "nominatim") violations.push("provider is invalid");
  if (!(geo.placeName === null || isNonEmptyString(geo.placeName))) violations.push("placeName is invalid");
  if (!isNonEmptyString(geo.query)) violations.push("query is missing");
  if (!isFiniteNumber(geo.osmId) || !Number.isSafeInteger(geo.osmId) || geo.osmId <= 0) violations.push("osmId is invalid");
  if (!["node", "way", "relation"].includes(geo.osmType as string)) violations.push("osmType is invalid");
  return violations;
}

export function isResolvedLocation(value: unknown): value is ResolvedLocation | null {
  return resolvedLocationViolations(value).length === 0;
}
