import { getFirestore, Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { ScrapedEvent } from "../scrapers/base.js";
import { type ResolvedLocation, isNycForFreeEventUrl, isWithinNycViewbox } from "./geocoder.js";
import { resolvedLocationViolations } from "./pipeline/contracts.js";
import { isUsableEventUrl } from "./eventUrl.js";
import { addDays, etDateParts, etTimestamp } from "./etTime.js";

export function nycDayBounds(timestamp: number): { start: number; end: number } {
  const date = etDateParts(timestamp);
  const next = addDays(date, 1);
  return { start: etTimestamp(date.year, date.month, date.day, 0, 0), end: etTimestamp(next.year, next.month, next.day, 0, 0) };
}

export function parseDuplicateResponse(text: string, candidateCount: number): number | null {
  if (text === "none") return null;
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (Number.isSafeInteger(index) && index < candidateCount) return index;
  }
  throw new Error("Invalid duplicate-matching response");
}

const EVENTS_COLLECTION = "events";

function hasSource(data: Record<string, unknown>, url: string): boolean {
  return data.sourceUrl === url || (Array.isArray(data.sourceUrls) && data.sourceUrls.includes(url));
}

function sameTitle(event: ScrapedEvent, data: Record<string, unknown>): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return typeof data.title === "string" && normalize(data.title) === normalize(event.title);
}

function conflictingOccurrence(event: ScrapedEvent, data: Record<string, unknown>): boolean {
  if (!event.sourceOccurrenceId || !hasSource(data, event.sourceUrl)) return false;
  if (typeof data.sourceOccurrenceId === "string") return data.sourceOccurrenceId !== event.sourceOccurrenceId;
  // A legacy fuzzy merge may already have attached several distinct event URLs
  // to one row. Sharing one of those URLs does not prove this is the same event.
  return !sameTitle(event, data);
}

function sameStartDay(event: ScrapedEvent, data: Record<string, unknown>): boolean {
  const start = (data.startTime as Timestamp | undefined)?.toMillis?.();
  if (typeof start !== "number") return false;
  const day = nycDayBounds(event.startTimestamp);
  return start >= day.start && start < day.end;
}

function canMigrateLegacySingleRun(event: ScrapedEvent, geo: ResolvedLocation | null): boolean {
  if (event.sourceName !== "nycforfree" || event.temporalStatus !== "limited_run" ||
      !isNycForFreeEventUrl(event.sourceUrl) || !geo ||
      !isWithinNycViewbox(geo.latitude, geo.longitude) || resolvedLocationViolations(geo).length > 0 ||
      (geo.provider === "nycforfree" && geo.query !== event.sourceUrl) ||
      !Number.isFinite(event.startTimestamp) || !Number.isFinite(event.endTimestamp) ||
      !Number.isFinite(new Date(event.startTimestamp).getTime()) ||
      !Number.isFinite(new Date(event.endTimestamp).getTime()) || event.endTimestamp <= event.startTimestamp) return false;
  const slug = new URL(event.sourceUrl).pathname.split("/")[2];
  return event.sourceOccurrenceId === `${slug}|run|single`;
}

function resolvedLocationFields(geo: ResolvedLocation): Record<string, unknown> {
  return {
    latitude: geo.latitude,
    longitude: geo.longitude,
    resolvedAddress: geo.formattedAddress,
    resolvedPlaceName: geo.placeName,
    geocodingProvider: geo.provider,
    geocodingQuery: geo.query,
    geocodedAt: Timestamp.now(),
    osmId: geo.osmId,
    osmType: geo.osmType,
  };
}

async function updateResolvedLocation(
  ref: DocumentReference,
  geo: ResolvedLocation | null
): Promise<void> {
  if (!geo) return;
  await ref.update(resolvedLocationFields(geo));
}

function sourceUrlQuality(value: string): number {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase().endsWith("eventbrite.com")) {
      return isUsableEventUrl(value) ? 4 : 0;
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    return pathParts.length > 0 ? 3 : 1;
  } catch {
    return 0;
  }
}

function mergeSourceUrls(data: Record<string, unknown>, newUrl: string): string[] {
  const rawUrls = Array.isArray(data.sourceUrls)
    ? data.sourceUrls
    : typeof data.sourceUrl === "string"
      ? [data.sourceUrl]
      : [];
  const existingUrls = rawUrls.filter(
    (url): url is string => typeof url === "string" && isUsableEventUrl(url)
  );
  const primaryCandidate =
    typeof data.sourceUrl === "string" && isUsableEventUrl(data.sourceUrl)
      ? data.sourceUrl
      : null;
  const bestExisting = [primaryCandidate, ...existingUrls]
    .filter((url): url is string => Boolean(url))
    .sort((a, b) => sourceUrlQuality(b) - sourceUrlQuality(a))[0];
  const primary =
    bestExisting && sourceUrlQuality(bestExisting) > sourceUrlQuality(newUrl)
      ? bestExisting
      : newUrl;
  return [primary, ...[newUrl, ...existingUrls].filter((url) => url !== primary)].filter(
    (url, index, urls) => urls.indexOf(url) === index
  );
}

async function updateSourceUrl(
  ref: DocumentReference,
  data: Record<string, unknown>,
  newUrl: string
): Promise<boolean> {
  const sourceUrls = mergeSourceUrls(data, newUrl);
  const sourceUrl = sourceUrls[0];
  const currentUrls = Array.isArray(data.sourceUrls) ? data.sourceUrls : [];
  if (data.sourceUrl === sourceUrl && JSON.stringify(currentUrls) === JSON.stringify(sourceUrls)) {
    return false;
  }
  await ref.update({ sourceUrl, sourceUrls });
  return true;
}

async function findFuzzyDuplicate(
  event: ScrapedEvent,
  startDate: Date,
  candidates: Array<{ id: string; title: string; location: string; startTime: Timestamp }>,
  apiKey: string
): Promise<string | null> {
  if (candidates.length === 0) return null;

  // Keep a single provider call below the 300s write-task deadline. Retry
  // at the queue boundary, not inside an SDK whose timeout outlives the task.
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 0 });

  const candidateList = candidates
    .map((c, i) => `${i}: "${c.title}" at "${c.location}" on ${c.startTime.toDate().toISOString()}`)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: `Is this new event the same real-world event as any of the existing events below? Events from different sources often have slightly different titles or locations but refer to the same thing (e.g. "Smorgasburg Williamsburg" and "Smorgasburg WTC" are DIFFERENT events, but "Smorgasburg World Trade Center" and "Smorgasburg WTC" are the SAME).

New event: "${event.title}" at "${event.location}" on ${startDate.toISOString()}

Existing events:
${candidateList}

If one is the same event, respond with ONLY the number (e.g. "0"). If none match, respond with "none".`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";

  const index = parseDuplicateResponse(text, candidates.length);
  return index === null ? null : candidates[index].id;
}

export type UpsertOutcome =
  | { kind: "added"; eventId: string }
  | { kind: "merged"; eventId: string; match: "source-occurrence" | "title+time" | "title+location" | "fuzzy" }
  | { kind: "skipped"; reason: string };

// Dedup-and-write for one event: the write stage of the pipeline. Exact
// matches merge first (title + start time + place, then title + place), then
// an LLM fuzzy match against same-day events. A merge never overwrites the
// category; it adds the source URL and refreshes the pin. New events need an
// exact location.
//
// addId makes the insert idempotent: a redelivered task that already added
// this event finds the document and reports it instead of adding it twice.
// Fuzzy-match failures throw so the queue retries the task.
export async function upsertEvent(
  event: ScrapedEvent,
  geo: ResolvedLocation | null,
  apiKey: string,
  addId: string,
  deps: { db?: Firestore; fuzzyDuplicate?: typeof findFuzzyDuplicate } = {}
): Promise<UpsertOutcome> {
  const db = deps.db ?? getFirestore();
  const category = event.category ?? "happening";
  const startDate = new Date(event.startTimestamp);
  const endDate = new Date(event.endTimestamp);
  const candidateUrl = event.sourceUrl || null;
  const newUrl = candidateUrl && isUsableEventUrl(candidateUrl) ? candidateUrl : null;

  const merge = async (
    ref: DocumentReference,
    data: Record<string, unknown> | undefined,
    match: "source-occurrence" | "title+time" | "title+location" | "fuzzy"
  ): Promise<UpsertOutcome> => {
    await updateResolvedLocation(ref, geo);
    // A new extraction/replay of the same source occurrence can correct its
    // duration. Keep curated categories/votes intact; never apply another
    // source's schedule or turn a different recurring date into this record.
    const sameIdentity = event.sourceOccurrenceId !== undefined &&
      data?.sourceOccurrenceId === event.sourceOccurrenceId;
    if (data && newUrl && hasSource(data, newUrl) && !conflictingOccurrence(event, data) &&
      (sameIdentity || (sameTitle(event, data) && sameStartDay(event, data)))) {
      await ref.update({
        startTime: Timestamp.fromDate(startDate),
        endTime: Timestamp.fromDate(endDate),
        location: event.location,
        temporalStatus: event.temporalStatus,
        temporalEvidence: event.temporalEvidence,
        ...(event.sourceOccurrenceId ? { sourceOccurrenceId: event.sourceOccurrenceId } : {}),
      });
    }
    if (data && newUrl && (await updateSourceUrl(ref, data, newUrl))) {
      console.log(`Updated source URL (${match}): "${event.title}"`);
    }
    return { kind: "merged", eventId: ref.id, match };
  };

  const existing = await db.collection(EVENTS_COLLECTION).doc(addId).get();
  if (existing.exists) {
    return { kind: "added", eventId: addId };
  }

  // Source-backed identity stays stable when a run's final date or address
  // formatting is corrected. It is scoped to the same source detail URL.
  if (event.sourceOccurrenceId) {
    const occurrences = await db.collection(EVENTS_COLLECTION)
      .where("sourceOccurrenceId", "==", event.sourceOccurrenceId).get();
    const occurrence = occurrences.docs.find((doc) => hasSource(doc.data(), event.sourceUrl));
    if (occurrence) return merge(occurrence.ref, occurrence.data(), "source-occurrence");
  }

  // A single continuous source run may predate occurrence IDs and have a
  // wrong pin/location label. Only its primary publisher URL, canonical title
  // and NYC opening day establish this narrow legacy identity; a secondary
  // URL from an earlier conflation does not. Read every candidate before writes.
  if (canMigrateLegacySingleRun(event, geo)) {
    const legacy = await db.collection(EVENTS_COLLECTION)
      .where("sourceUrl", "==", event.sourceUrl).get();
    const matches = legacy.docs.filter((doc) => {
      const data = doc.data();
      const start = data.startTime?.toMillis?.();
      const end = data.endTime?.toMillis?.();
      return data.sourceUrl === event.sourceUrl && data.temporalStatus === "limited_run" &&
        !("sourceOccurrenceId" in data) && sameTitle(event, data) &&
        typeof start === "number" && Number.isFinite(start) &&
        typeof end === "number" && Number.isFinite(end) && end > start && sameStartDay(event, data);
    });
    if (matches.length > 1) throw new Error("Ambiguous legacy single-run source occurrence");
    if (matches.length === 1) return merge(matches[0].ref, matches[0].data(), "source-occurrence");
  }

  // Exact dedup: same title + start time, at the same named place. Multi-location
  // events often share a title and start time but need separate pins.
  const titleTimeQuery = await db
    .collection(EVENTS_COLLECTION)
    .where("title", "==", event.title)
    .where("startTime", "==", Timestamp.fromDate(startDate))
    .get();
  const titleTimeMatch = titleTimeQuery.docs.find(
    (doc) => !conflictingOccurrence(event, doc.data()) &&
      (doc.data().location || "").trim().toLowerCase() === event.location.trim().toLowerCase()
  );
  if (titleTimeMatch) {
    return merge(titleTimeMatch.ref, titleTimeMatch.data(), "title+time");
  }

  // Exact dedup: same title + same location
  if (event.location) {
    const titleLocQuery = await db
      .collection(EVENTS_COLLECTION)
      .where("title", "==", event.title)
      .where("location", "==", event.location)
      .get();
    // Recurring shows at the same venue are distinct events. Only merge a
    // title/place match when its actual time interval overlaps this one.
    const doc = titleLocQuery.docs.find((candidate) => {
      const data = candidate.data();
      const start = data.startTime?.toMillis?.();
      const end = data.endTime?.toMillis?.();
      return !conflictingOccurrence(event, data) && typeof start === "number" && typeof end === "number" &&
        start < event.endTimestamp && end > event.startTimestamp;
    });
    if (doc) return merge(doc.ref, doc.data(), "title+location");
  }

  // Fuzzy dedup: find events on the same day and ask Claude
  const day = nycDayBounds(event.startTimestamp);
  const sameDayQuery = await db
    .collection(EVENTS_COLLECTION)
    .where("startTime", ">=", Timestamp.fromMillis(day.start))
    .where("startTime", "<", Timestamp.fromMillis(day.end))
    .get();
  if (!sameDayQuery.empty) {
    const candidates = sameDayQuery.docs.filter((doc) => {
      const data = doc.data();
      const start = data.startTime?.toMillis?.();
      const end = data.endTime?.toMillis?.();
      return !conflictingOccurrence(event, data) && typeof start === "number" && typeof end === "number" &&
        start < event.endTimestamp && end > event.startTimestamp;
    }).map((doc) => ({
      id: doc.id,
      title: doc.data().title,
      location: doc.data().location || "",
      startTime: doc.data().startTime,
    }));
    const matchId = await (deps.fuzzyDuplicate ?? findFuzzyDuplicate)(event, startDate, candidates, apiKey);
    if (matchId) {
      const matchRef = db.collection(EVENTS_COLLECTION).doc(matchId);
      const matchDoc = await matchRef.get();
      return merge(matchRef, matchDoc.data(), "fuzzy");
    }
  }

  if (!geo) {
    return { kind: "skipped", reason: `unresolved location "${event.location}"` };
  }

  try {
    await db.collection(EVENTS_COLLECTION).doc(addId).create({
      title: event.title,
      description: event.description,
      location: event.location,
      category,
      temporalStatus: event.temporalStatus,
      temporalEvidence: event.temporalEvidence,
      ...resolvedLocationFields(geo),
      startTime: Timestamp.fromDate(startDate),
      endTime: Timestamp.fromDate(endDate),
      sourceUrl: newUrl,
      sourceUrls: newUrl ? [newUrl] : [],
      ...(event.sourceOccurrenceId ? { sourceOccurrenceId: event.sourceOccurrenceId } : {}),
      createdAt: Timestamp.now(),
    });
  } catch (error) {
    // ALREADY_EXISTS: a concurrent delivery of the same task got there first.
    if ((error as { code?: number }).code !== 6) throw error;
  }
  console.log(`Added [${category}]: "${event.title}"`);
  return { kind: "added", eventId: addId };
}
