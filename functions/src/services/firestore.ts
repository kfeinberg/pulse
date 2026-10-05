import { getFirestore, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { ScrapedEvent } from "../scrapers/base.js";
import { resolveEventLocation, type ResolvedLocation } from "./geocoder.js";


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

export async function writeScrapedEvents(
  events: ScrapedEvent[],
  apiKey: string
): Promise<number> {
  const db = getFirestore();
  let addedCount = 0;
  let mergedCount = 0;
  let skippedExact = 0;

  const validEvents = events.filter((event) => {
    if (!event.title) {
      console.log(`Skipped: no title`);
      return false;
    }
    return true;
  });

  console.log(`${events.length} total, ${validEvents.length} valid to process`);

  for (let i = 0; i < validEvents.length; i++) {
    const event = validEvents[i];
    const category = event.category ?? "happening";

    const startDate = new Date(event.startTimestamp);
    const endDate = new Date(event.endTimestamp);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      console.warn(`Skipped: invalid timestamp for "${event.title}" (start=${event.startTimestamp}, end=${event.endTimestamp})`);
      continue;
    }

    const newUrl = event.sourceUrl || null;
    const geo = await resolveEventLocation(event);

    // Exact dedup: same title + same start time
    const titleTimeQuery = await db
      .collection(EVENTS_COLLECTION)
      .where("title", "==", event.title)
      .where("startTime", "==", Timestamp.fromDate(startDate))
      .get();

    const titleTimeMatch = titleTimeQuery.docs.find(
      (doc) => (doc.data().location || "").trim().toLowerCase() === event.location.trim().toLowerCase()
    );
    if (titleTimeMatch) {
      // Only merge title+time matches at the same named place. Multi-location
      // events often share a title and start time but need separate pins.
      const existingDoc = titleTimeMatch;
      await updateResolvedLocation(existingDoc.ref, geo);
      if (newUrl) {
        const data = existingDoc.data();
        const existingUrls: string[] = data.sourceUrls || (data.sourceUrl ? [data.sourceUrl] : []);
        if (!existingUrls.includes(newUrl)) {
          await existingDoc.ref.update({ sourceUrls: [...existingUrls, newUrl] });
          mergedCount++;
          console.log(`Merged URL into existing (title+time): "${event.title}"`);
        } else {
          skippedExact++;
        }
      } else {
        skippedExact++;
      }
      continue;
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
        const existingDoc = titleLocQuery.docs[0];
        await updateResolvedLocation(existingDoc.ref, geo);
        if (newUrl) {
          const data = existingDoc.data();
          const existingUrls: string[] = data.sourceUrls || (data.sourceUrl ? [data.sourceUrl] : []);
          if (!existingUrls.includes(newUrl)) {
            await existingDoc.ref.update({ sourceUrls: [...existingUrls, newUrl] });
            mergedCount++;
            console.log(`Merged URL into existing (title+loc): "${event.title}"`);
          } else {
            skippedExact++;
          }
        } else {
          skippedExact++;
        }
        continue;
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

      try {
        const matchId = await findFuzzyDuplicate(event, startDate, candidates, apiKey);
        if (matchId) {
          const matchRef = db.collection(EVENTS_COLLECTION).doc(matchId);
          await updateResolvedLocation(matchRef, geo);
          const matchDoc = await matchRef.get();
          const matchData = matchDoc.data();
          if (matchData && newUrl) {
            const existingUrls: string[] = matchData.sourceUrls || (matchData.sourceUrl ? [matchData.sourceUrl] : []);
            if (!existingUrls.includes(newUrl)) {
              await matchRef.update({ sourceUrls: [...existingUrls, newUrl] });
              mergedCount++;
              console.log(`Merged URL (fuzzy match): "${event.title}" → "${matchData.title}"`);
            } else {
              skippedExact++;
              console.log(`Skipped (fuzzy, URL exists): "${event.title}"`);
            }
          }
          continue;
        }
      } catch (err) {
        console.warn(`Fuzzy dedup failed for "${event.title}", proceeding to add:`, err);
      }
    }

    // No duplicate found — add only events whose location can be resolved exactly.
    if (!geo) {
      console.warn(`Skipped: unresolved location for "${event.title}" at "${event.location}"`);
      continue;
    }

    await db.collection(EVENTS_COLLECTION).add({
      title: event.title,
      description: event.description,
      location: event.location,
      category,
      ...resolvedLocationFields(geo),
      startTime: Timestamp.fromDate(startDate),
      endTime: Timestamp.fromDate(endDate),
      sourceUrl: newUrl,
      sourceUrls: newUrl ? [newUrl] : [],
      createdAt: Timestamp.now(),
    });

    addedCount++;
    console.log(`Added [${category}]: "${event.title}"`);
  }

  console.log(
    `Done: ${addedCount} added, ${mergedCount} merged, ${skippedExact} exact duplicates skipped`
  );
  return addedCount;
}
