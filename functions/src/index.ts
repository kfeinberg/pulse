import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { defineSecret } from "firebase-functions/params";
import { getAllSources } from "./scrapers/index.js";
import { parsePoshPayload } from "./scrapers/sites/posh.js";
import { upsertEvent } from "./services/firestore.js";
import { resolveEventLocation } from "./services/geocoder.js";
import {
  deleteExpiredExtractionCache,
  ExtractionCache,
} from "./services/extractionCache.js";
import {
  COLLECTIONS,
  deleteOldCheckpoints,
  firestorePipelineStore,
  type Stage,
} from "./services/pipeline/checkpoints.js";
import { checkpointExtracted, runExtractStage, type SourceRunSummary } from "./services/pipeline/extract.js";
import { cloudTasksEnqueuer, STAGE_QUEUES } from "./services/pipeline/queue.js";
import { parseReplayRequest, replay } from "./services/pipeline/replay.js";
import { runWithDeadLetter, type StageDeps, type StageTask } from "./services/pipeline/stages.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { Expo, ExpoPushMessage } from "expo-server-sdk";

initializeApp();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const poshIngestToken = defineSecret("POSH_INGEST_TOKEN");

function hasValidPoshToken(provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = poshIngestToken.value();
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

// Cloud Scheduler and the Posh relay are both at-least-once: the same run
// occasionally arrives twice (seen as two full dailyScrape runs on one day,
// and every Posh payload POSTed twice). Each run claims a lock document in a
// transaction first; a duplicate that finds a completed or still-running
// claim exits without scraping or calling Claude. A failed run releases its
// claim so a genuine retry can proceed.
const RUN_LOCKS_COLLECTION = "_runLocks";
const RUN_LEASE_MS = 35 * 60 * 1000; // longer than the 1800s function timeout

async function claimRun(lockId: string): Promise<boolean> {
  const db = getFirestore();
  const ref = db.collection(RUN_LOCKS_COLLECTION).doc(lockId);
  return db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data();
    if (data?.status === "completed") return false;
    if (
      data?.status === "running" &&
      Date.now() - data.startedAt.toMillis() < RUN_LEASE_MS
    ) {
      return false;
    }
    tx.set(ref, { status: "running", startedAt: Timestamp.now() });
    return true;
  });
}

async function finishRun(lockId: string, status: "completed" | "failed"): Promise<void> {
  await getFirestore()
    .collection(RUN_LOCKS_COLLECTION)
    .doc(lockId)
    .update({ status, finishedAt: Timestamp.now() });
}

const ADMIN_EMAIL = "kalli.feinberg@gmail.com";

function stageDeps(apiKey: string): StageDeps {
  return {
    store: firestorePipelineStore(),
    enqueue: cloudTasksEnqueuer(),
    geocode: resolveEventLocation,
    upsert: (event, geo, addId) => upsertEvent(event, geo, apiKey, addId),
  };
}

function describe(summary: SourceRunSummary): string {
  const base =
    `${summary.source}: listed ${summary.listed}, extracted ${summary.extracted} new events ` +
    `(${summary.skippedByCache} items already extracted), queued ${summary.queued}`;
  return summary.health.tripped ? `${base}; HELD by circuit breaker: ${summary.health.reason}` : base;
}

// Runs the extract stage for every source (or one, with `only`). Each source
// is isolated: a failure is recorded and the run moves on. Extracted items are
// checkpointed and queued; gate, geocode and write happen in their own queues.
// force: send every item to Claude even if it was extracted before.
async function runScraper(
  apiKey: string,
  runId: string,
  options: { force?: boolean; only?: string } = {}
): Promise<string[]> {
  const sources = getAllSources(apiKey).filter((s) => !options.only || s.name === options.only);
  if (options.only && sources.length === 0) throw new Error(`Unknown source "${options.only}"`);
  const deps = { store: firestorePipelineStore(), enqueue: cloudTasksEnqueuer() };
  const results: string[] = [];
  const ledger: Record<string, unknown> = {};

  for (const source of sources) {
    try {
      console.log(`Scraping source: ${source.name}`);
      const summary = await runExtractStage(source, runId, deps, { force: options.force });
      ledger[source.name] = summary;
      results.push(describe(summary));
      console.log(describe(summary));
    } catch (error) {
      const msg = `${source.name}: error — ${error}`;
      ledger[source.name] = { error: String(error) };
      console.error(msg);
      results.push(msg);
    }
  }

  await getFirestore().collection(COLLECTIONS.runs).doc(runId).set(
    { createdAt: Timestamp.now(), sources: JSON.parse(JSON.stringify(ledger)) },
    { merge: true }
  );
  console.log(JSON.stringify({
    message: "Scrape run complete",
    runId,
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
    const etDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const lockId = `dailyScrape-${etDate}`;
    if (!(await claimRun(lockId))) {
      console.log(`Skipping duplicate dailyScrape delivery for ${etDate}`);
      return;
    }
    try {
      const results = await runScraper(anthropicApiKey.value(), lockId);
      await finishRun(lockId, "completed");
      console.log("Daily scrape complete:", results);
    } catch (error) {
      await finishRun(lockId, "failed");
      throw error;
    }
  }
);

// HTTP trigger for manual testing — includes full pipeline debug.
// ?force=1 re-extracts items that were already extracted; ?source=<name>
// runs only that source.
export const scrapeNow = onRequest(
  { secrets: [anthropicApiKey], timeoutSeconds: 1800, memory: "2GiB" },
  async (req, res) => {
    const debug: Record<string, unknown> = {};
    const apiKey = anthropicApiKey.value();
    debug.apiKeyPresent = !!apiKey;

    // Run full pipeline
    try {
      const only = typeof req.query.source === "string" ? req.query.source : undefined;
      const runId = `manual-${new Date().toISOString()}`;
      const results = await runScraper(apiKey, runId, { force: req.query.force === "1", only });
      debug.results = results;
    } catch (err) {
      debug.scraperError = String(err);
    }

    res.json(debug);
  }
);

// Posh blocks datacenter egress at Cloudflare. A small fetch relay on the
// owner's Mac sends the public Explore payload here; Firebase still validates,
// parses, geocodes, deduplicates, and stores every event.
export const ingestPoshEvents = onRequest(
  {
    secrets: [anthropicApiKey, poshIngestToken],
    timeoutSeconds: 1800,
    memory: "2GiB",
  },
  async (req, res) => {
    if (req.method !== "POST" || !hasValidPoshToken(req.header("x-posh-ingest-token"))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Identical payloads carry no new events, so process each one once.
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(req.body?.events ?? null))
      .digest("hex");
    const lockId = `posh-${payloadHash.slice(0, 32)}`;
    if (!(await claimRun(lockId))) {
      console.log(`Skipping duplicate Posh payload ${lockId}`);
      res.json({ source: "posh", status: "duplicate" });
      return;
    }

    const auditRef = getFirestore().collection("_scraperAudits").doc("posh");
    const startedAt = Date.now();
    try {
      const cache = new ExtractionCache("posh");
      const events = await parsePoshPayload(req.body?.events, anthropicApiKey.value(), cache);
      // Posh pushes its payload rather than being fetched, and the payload is
      // validated already, so it skips the source circuit breaker.
      const summary = await checkpointExtracted("posh", events, cache, lockId,
        { store: firestorePipelineStore(), enqueue: cloudTasksEnqueuer() }, { breaker: false });
      const result = {
        source: "posh",
        // A payload of only already-extracted events is healthy, not empty.
        status: events.length > 0 || cache.skipped > 0 ? "ok" : "empty",
        count: events.length,
        alreadyExtracted: cache.skipped,
        queued: summary.queued,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        samples: events.slice(0, 5).map((event) => ({
          title: event.title,
          location: event.location,
          sourceUrl: event.sourceUrl,
        })),
        completedAt: Timestamp.now(),
      };
      await auditRef.set(result);
      await finishRun(lockId, "completed");
      res.json(result);
    } catch (error) {
      const result = {
        source: "posh",
        status: "error",
        error: String(error),
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        completedAt: Timestamp.now(),
      };
      await auditRef.set(result);
      await finishRun(lockId, "failed");
      console.error("Posh ingestion failed:", error);
      res.status(500).json(result);
    }
  }
);

// Pipeline stage workers. Each item moves through gate → geocode → write as
// its own task, with per-stage retries; the last failed attempt quarantines
// the item (dead letter) instead of retrying forever.
function stageWorker(stage: Stage) {
  const queue = STAGE_QUEUES[stage];
  return onTaskDispatched<StageTask>(
    {
      retryConfig: queue.retryConfig,
      rateLimits: queue.rateLimits,
      timeoutSeconds: queue.timeoutSeconds,
      secrets: stage === "write" ? [anthropicApiKey] : [],
    },
    async (request) => {
      const deps = stageDeps(stage === "write" ? anthropicApiKey.value() : "");
      const result = await runWithDeadLetter(
        stage, request.data, request.retryCount, queue.retryConfig.maxAttempts, deps
      );
      console.log(`[${stage}] ${request.data.inputId}: ${JSON.stringify(result)}`);
    }
  );
}

export const pipelineGate = stageWorker("gate");
export const pipelineGeocode = stageWorker("geocode");
export const pipelineWrite = stageWorker("write");

// Admin-only replay. { stage: "gate" | "geocode" | "write", source?, since?,
// until?, inputId?, releaseQuarantine? } reruns that stage (and everything
// after it) from its saved inputs. { stage: "extract", source, force? }
// re-fetches and re-extracts one source.
export const replayStage = onCall(
  { secrets: [anthropicApiKey], timeoutSeconds: 1800, memory: "2GiB" },
  async (request) => {
    const token = request.auth?.token;
    if (!token || token.email !== ADMIN_EMAIL || token.email_verified !== true) {
      throw new HttpsError("permission-denied", "Admin only");
    }
    const body = (request.data ?? {}) as Record<string, unknown>;
    if (body.stage === "extract") {
      if (typeof body.source !== "string") throw new HttpsError("invalid-argument", "source is required");
      const runId = `replay-${new Date().toISOString()}`;
      return { results: await runScraper(anthropicApiKey.value(), runId, { only: body.source, force: body.force === true }) };
    }
    let parsed;
    try {
      parsed = parseReplayRequest(body);
    } catch (error) {
      throw new HttpsError("invalid-argument", String(error));
    }
    return replay(parsed, { store: firestorePipelineStore(), enqueue: cloudTasksEnqueuer() });
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
    try {
      const expired = await deleteExpiredExtractionCache();
      console.log(`Cleaned up ${expired} expired extraction cache entries`);
      const checkpoints = await deleteOldCheckpoints(14);
      console.log(`Cleaned up ${checkpoints} pipeline checkpoints older than 14 days`);
    } catch (error) {
      console.error("Extraction cache / checkpoint cleanup failed:", error);
    }

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

// Callable: delete a user's account and all associated data
export const deleteAccount = onCall(
  { timeoutSeconds: 60 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Must be signed in");
    }

    const db = getFirestore();
    const batch = db.batch();

    // Delete user profile
    batch.delete(db.collection("users").doc(uid));

    // Delete user's reports
    const reportsSnap = await db
      .collection("reports")
      .where("userId", "==", uid)
      .get();
    for (const doc of reportsSnap.docs) {
      batch.delete(doc.ref);
    }

    // Delete user's event interests
    const interestsSnap = await db
      .collection("eventInterests")
      .where("userId", "==", uid)
      .get();
    for (const doc of interestsSnap.docs) {
      batch.delete(doc.ref);
    }

    await batch.commit();

    // Delete comments across all events (subcollections need separate queries)
    const eventsSnap = await db.collection("events").get();
    for (const eventDoc of eventsSnap.docs) {
      const commentsSnap = await eventDoc.ref
        .collection("comments")
        .where("userId", "==", uid)
        .get();
      if (!commentsSnap.empty) {
        const commentBatch = db.batch();
        for (const commentDoc of commentsSnap.docs) {
          commentBatch.delete(commentDoc.ref);
        }
        await commentBatch.commit();
      }
    }

    // Delete the Firebase Auth user
    await getAuth().deleteUser(uid);

    console.log(`Deleted account and data for user ${uid}`);
    return { success: true };
  }
);
