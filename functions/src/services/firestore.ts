import { getFirestore, Timestamp } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { ScrapedEvent } from "../scrapers/base.js";


const EVENTS_COLLECTION = "events";

interface GeoResult {
  latitude: number;
  longitude: number;
}

async function geocodeWithClaude(
  location: string,
  apiKey: string
): Promise<GeoResult> {
  const fallback: GeoResult = { latitude: 40.7128, longitude: -74.006 };
  if (!location) return fallback;

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `Given this NYC location/address, return the approximate latitude and longitude as JSON: {"latitude": number, "longitude": number}. Location: "${location}". Return ONLY the JSON, nothing else.`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";

  try {
    const cleaned = text
      .replace(/^```(?:json)?\n?/g, "")
      .replace(/\n?```$/g, "");
    const result = JSON.parse(cleaned) as GeoResult;
    if (
      typeof result.latitude === "number" &&
      typeof result.longitude === "number"
    ) {
      return result;
    }
  } catch {
    console.warn(`Geocoding failed for "${location}", using fallback`);
  }

  return fallback;
}

export async function writeScrapedEvents(
  events: ScrapedEvent[],
  apiKey: string
): Promise<number> {
  const db = getFirestore();
  let addedCount = 0;
  let skippedDup = 0;
  let skippedTitleTime = 0;
  let skippedTitleLoc = 0;
  let skippedLocTime = 0;

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

    // Dedup: check for same title + same start time
    const titleTimeQuery = await db
      .collection(EVENTS_COLLECTION)
      .where("title", "==", event.title)
      .where("startTime", "==", Timestamp.fromDate(startDate))
      .limit(1)
      .get();

    if (!titleTimeQuery.empty) {
      skippedDup++;
      skippedTitleTime++;
      console.log(`Skipped dup (title+time): "${event.title}" at ${startDate.toISOString()}`);
      continue;
    }

    // Dedup: check for same title + same location
    if (event.location) {
      const titleLocQuery = await db
        .collection(EVENTS_COLLECTION)
        .where("title", "==", event.title)
        .where("location", "==", event.location)
        .limit(1)
        .get();

      if (!titleLocQuery.empty) {
        skippedDup++;
        skippedTitleLoc++;
        console.log(`Skipped dup (title+location): "${event.title}" at "${event.location}"`);
        continue;
      }
    }

    // Dedup: check for same location + same start time
    if (event.location) {
      const locTimeQuery = await db
        .collection(EVENTS_COLLECTION)
        .where("location", "==", event.location)
        .where("startTime", "==", Timestamp.fromDate(startDate))
        .limit(1)
        .get();

      if (!locTimeQuery.empty) {
        skippedDup++;
        skippedLocTime++;
        console.log(`Skipped dup (location+time): "${event.location}" at ${startDate.toISOString()}`);
        continue;
      }
    }

    // Use coordinates from scraper if available, otherwise geocode
    const geo =
      event.latitude != null && event.longitude != null
        ? { latitude: event.latitude, longitude: event.longitude }
        : await geocodeWithClaude(event.location, apiKey);

    await db.collection(EVENTS_COLLECTION).add({
      title: event.title,
      description: event.description,
      location: event.location,
      category,
      latitude: geo.latitude,
      longitude: geo.longitude,
      startTime: Timestamp.fromDate(startDate),
      endTime: Timestamp.fromDate(endDate),
      createdAt: Timestamp.now(),
    });

    addedCount++;
    console.log(`Added [${category}]: "${event.title}"`);
  }

  console.log(
    `Done: ${addedCount} added, ${skippedDup} duplicates skipped (title+time: ${skippedTitleTime}, title+location: ${skippedTitleLoc}, location+time: ${skippedLocTime})`
  );
  return addedCount;
}
