import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getAllSources } from "./scrapers/index.js";
import { writeScrapedEvents } from "./services/firestore.js";
import { Expo, ExpoPushMessage } from "expo-server-sdk";

initializeApp();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

async function runScraper(apiKey: string): Promise<string[]> {
  const sources = getAllSources(apiKey);
  const results: string[] = [];

  for (const source of sources) {
    try {
      console.log(`Scraping source: ${source.name}`);
      const events = await source.scrape();
      console.log(`Found ${events.length} events from ${source.name}`);

      const added = await writeScrapedEvents(events, apiKey);
      const msg = `${source.name}: found ${events.length} events, added ${added} new`;
      console.log(msg);
      results.push(msg);
    } catch (error) {
      const msg = `${source.name}: error — ${error}`;
      console.error(msg);
      results.push(msg);
    }
  }

  console.log(JSON.stringify({
    message: "Scrape run complete",
    summary: results,
    timestamp: new Date().toISOString(),
  }));

  return results;
}

// Scheduled: runs daily at 8am ET
export const dailyScrape = onSchedule(
  {
    schedule: "0 8 * * *",
    timeZone: "America/New_York",
    timeoutSeconds: 1800,
    memory: "2GiB",
    secrets: [anthropicApiKey],
  },
  async () => {
    const results = await runScraper(anthropicApiKey.value());
    console.log("Daily scrape complete:", results);
  }
);

// HTTP trigger for manual testing — includes full pipeline debug
export const scrapeNow = onRequest(
  { secrets: [anthropicApiKey], timeoutSeconds: 1800, memory: "2GiB" },
  async (_req, res) => {
    const debug: Record<string, unknown> = {};
    const apiKey = anthropicApiKey.value();
    debug.apiKeyPresent = !!apiKey;

    // Run full pipeline
    try {
      const results = await runScraper(apiKey);
      debug.results = results;
    } catch (err) {
      debug.scraperError = String(err);
    }

    res.json(debug);
  }
);

// Scheduled: runs daily at 3am ET, deletes events that have ended
export const dailyCleanup = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "America/New_York",
    timeoutSeconds: 120,
  },
  async () => {
    const db = getFirestore();
    const now = new Date();
    const snapshot = await db
      .collection("events")
      .where("endTime", "<", now)
      .get();

    if (snapshot.empty) {
      console.log("No expired events to clean up");
      return;
    }

    const batchSize = 500;
    let deleted = 0;
    for (let i = 0; i < snapshot.docs.length; i += batchSize) {
      const batch = db.batch();
      const chunk = snapshot.docs.slice(i, i + batchSize);
      for (const doc of chunk) {
        batch.delete(doc.ref);
      }
      await batch.commit();
      deleted += chunk.length;
    }

    console.log(`Cleaned up ${deleted} expired events`);
  }
);

// Scheduled: runs every 5 minutes, sends push notifications for events starting in ~30 min
export const sendEventReminders = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "America/New_York",
    timeoutSeconds: 60,
  },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    const windowStart = new Date(now + 25 * 60 * 1000);
    const windowEnd = new Date(now + 35 * 60 * 1000);

    // Find events starting in the 25-35 minute window
    const eventsSnap = await db
      .collection("events")
      .where("startTime", ">=", Timestamp.fromDate(windowStart))
      .where("startTime", "<=", Timestamp.fromDate(windowEnd))
      .get();

    if (eventsSnap.empty) {
      console.log("No events starting in ~30 minutes");
      return;
    }

    const eventIds = eventsSnap.docs.map((d) => d.id);
    const eventMap = new Map(
      eventsSnap.docs.map((d) => [d.id, d.data()])
    );

    console.log(`Found ${eventIds.length} events starting soon: ${eventIds.join(", ")}`);

    // Firestore 'in' queries support max 30 values — batch if needed
    const allInterests: Array<{ userId: string; eventId: string }> = [];
    for (let i = 0; i < eventIds.length; i += 30) {
      const batch = eventIds.slice(i, i + 30);
      const interestsSnap = await db
        .collection("eventInterests")
        .where("eventId", "in", batch)
        .get();
      for (const doc of interestsSnap.docs) {
        const data = doc.data();
        allInterests.push({ userId: data.userId, eventId: data.eventId });
      }
    }

    if (allInterests.length === 0) {
      console.log("No interested users for upcoming events");
      return;
    }

    // Get unique user IDs and fetch their push tokens
    const userIds = [...new Set(allInterests.map((i) => i.userId))];
    const tokenMap = new Map<string, string>();

    for (let i = 0; i < userIds.length; i += 30) {
      const batch = userIds.slice(i, i + 30);
      for (const uid of batch) {
        const userDoc = await db.collection("users").doc(uid).get();
        const data = userDoc.data();
        if (data?.expoPushToken) {
          tokenMap.set(uid, data.expoPushToken);
        }
      }
    }

    // Build push messages
    const expo = new Expo();
    const messages: ExpoPushMessage[] = [];

    for (const interest of allInterests) {
      const token = tokenMap.get(interest.userId);
      if (!token || !Expo.isExpoPushToken(token)) continue;

      const event = eventMap.get(interest.eventId);
      if (!event) continue;

      const startTime = event.startTime.toDate();
      const mins = Math.round((startTime.getTime() - now) / 60000);

      messages.push({
        to: token,
        sound: "default",
        title: event.title,
        body: `Starting in ${mins} minutes${event.location ? ` at ${event.location}` : ""}`,
        data: { eventId: interest.eventId },
      });
    }

    if (messages.length === 0) {
      console.log("No valid push tokens to send to");
      return;
    }

    // Send in chunks
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        console.error("Error sending push notifications:", err);
      }
    }

    console.log(`Sent ${messages.length} push notifications`);
  }
);
