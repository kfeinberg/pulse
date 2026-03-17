import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getAllSources } from "./scrapers/index.js";
import { writeScrapedEvents } from "./services/firestore.js";

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
