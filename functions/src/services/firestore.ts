import { getFirestore, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { ScrapedEvent } from "../scrapers/base.js";
import { type ResolvedLocation } from "./geocoder.js";
import { isUsableEventUrl } from "./eventUrl.js";


const EVENTS_COLLECTION = "events";

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

  const client = new Anthropic({ apiKey, timeout: 10 * 60 * 1000 });

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

  if (text === "none") return null;

  const index = parseInt(text, 10);
  if (!isNaN(index) && index >= 0 && index < candidates.length) {
    return candidates[index].id;
  }

  return null;
}

export type UpsertOutcome =
  | { kind: "added"; eventId: string }
  | { kind: "merged"; eventId: string; match: "title+time" | "title+location" | "fuzzy" }
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
  addId: string
): Promise<UpsertOutcome> {
  const db = getFirestore();
  const category = event.category ?? "happening";
  const startDate = new Date(event.startTimestamp);
  const endDate = new Date(event.endTimestamp);
  const candidateUrl = event.sourceUrl || null;
  const newUrl = candidateUrl && isUsableEventUrl(candidateUrl) ? candidateUrl : null;

  const merge = async (
    ref: DocumentReference,
    data: Record<string, unknown> | undefined,
    match: "title+time" | "title+location" | "fuzzy"
  ): Promise<UpsertOutcome> => {
    await updateResolvedLocation(ref, geo);
    if (data && newUrl && (await updateSourceUrl(ref, data, newUrl))) {
      console.log(`Updated source URL (${match}): "${event.title}"`);
    }
    return { kind: "merged", eventId: ref.id, match };
  };

  const existing = await db.collection(EVENTS_COLLECTION).doc(addId).get();
  if (existing.exists) {
    return { kind: "added", eventId: addId };
  }

  // Exact dedup: same title + start time, at the same named place. Multi-location
  // events often share a title and start time but need separate pins.
  const titleTimeQuery = await db
    .collection(EVENTS_COLLECTION)
    .where("title", "==", event.title)
    .where("startTime", "==", Timestamp.fromDate(startDate))
    .get();
  const titleTimeMatch = titleTimeQuery.docs.find(
    (doc) => (doc.data().location || "").trim().toLowerCase() === event.location.trim().toLowerCase()
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
      .limit(1)
      .get();
    if (!titleLocQuery.empty) {
      const doc = titleLocQuery.docs[0];
      return merge(doc.ref, doc.data(), "title+location");
    }
  }

  // Fuzzy dedup: find events on the same day and ask Claude
  const dayStart = new Date(startDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(startDate);
  dayEnd.setHours(23, 59, 59, 999);
  const sameDayQuery = await db
    .collection(EVENTS_COLLECTION)
    .where("startTime", ">=", Timestamp.fromDate(dayStart))
    .where("startTime", "<=", Timestamp.fromDate(dayEnd))
    .get();
  if (!sameDayQuery.empty) {
    const candidates = sameDayQuery.docs.map((doc) => ({
      id: doc.id,
      title: doc.data().title,
      location: doc.data().location || "",
      startTime: doc.data().startTime,
    }));
    const matchId = await findFuzzyDuplicate(event, startDate, candidates, apiKey);
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
      createdAt: Timestamp.now(),
    });
  } catch (error) {
    // ALREADY_EXISTS: a concurrent delivery of the same task got there first.
    if ((error as { code?: number }).code !== 6) throw error;
  }
  console.log(`Added [${category}]: "${event.title}"`);
  return { kind: "added", eventId: addId };
}
