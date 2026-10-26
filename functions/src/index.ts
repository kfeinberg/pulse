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
  itemKey,
} from "./services/extractionCache.js";
import {
  COLLECTIONS,
  deleteOldCheckpoints,
  firestorePipelineStore,
  type Stage,
} from "./services/pipeline/checkpoints.js";
import { runExtractStage, type SourceRunSummary } from "./services/pipeline/extract.js";
import { cloudTasksEnqueuer, STAGE_QUEUES } from "./services/pipeline/queue.js";
import { parseReplayRequest, replay } from "./services/pipeline/replay.js";
import { runWithDeadLetter, parseStageTask, type StageDeps, type StageTask } from "./services/pipeline/stages.js";
import { withRunLease, withStageLease, LeaseBusyError } from "./services/pipeline/leases.js";
import { authorizeAdminHeader, isAdminToken } from "./services/admin.js";
import { timingSafeEqual } from "node:crypto";
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

// Scheduled/relay work uses token-fenced leases. Busy duplicate deliveries
// retry instead of acknowledging a run whose first worker may still fail.
function stageDeps(apiKey: string): StageDeps {
  return {
    store: firestorePipelineStore(),
    enqueue: cloudTasksEnqueuer(),
    geocode: resolveEventLocation,
    upsert: (event, geo, addId) => upsertEvent(event, geo, apiKey, addId),
    exclusive: withStageLease,
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
  const failures: unknown[] = [];

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
      failures.push(error);
      console.error(msg);
      results.push(msg);
    }
  }

  await getFirestore().collection(COLLECTIONS.runs).doc(runId).set(
    { createdAt: Timestamp.now(), sources: JSON.parse(JSON.stringify(ledger)) },
    { mergeFields: ["createdAt", "sources"] }
  );
  console.log(JSON.stringify({
    message: "Scrape run complete",
    runId,
    summary: results,
    timestamp: new Date().toISOString(),
  }));

  if (failures.length) throw new AggregateError(failures, `${failures.length} source(s) failed; durable successful checkpoints are preserved`);
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
    retryCount: 3,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 300,
  },
  async (event) => {
    // A delayed retry still belongs to its scheduled day, not today's date.
    const etDate = new Date(event.scheduleTime).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const lockId = `dailyScrape-${etDate}`;
    const result = await withRunLease(lockId, () => runScraper(anthropicApiKey.value(), lockId));
    console.log(result.duplicate ? `Skipping completed dailyScrape ${etDate}` : "Daily scrape complete");
  }
);

// HTTP trigger for manual testing — includes full pipeline debug.
// ?force=1 re-extracts items that were already extracted; ?source=<name>
// runs only that source.
export const scrapeNow = onRequest(
  { secrets: [anthropicApiKey], timeoutSeconds: 1800, memory: "2GiB" },
  async (req, res) => {
    if (!(await authorizeAdminHeader(req.header("authorization"), (token) => getAuth().verifyIdToken(token, true)))) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
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

    // Fingerprint includes the extraction prompt/model/parser generation.
    const payloadHash = itemKey("posh-payload", JSON.stringify(req.body?.events ?? null));
    const lockId = `posh-${payloadHash.slice(0, 32)}`;
    const auditRef = getFirestore().collection("_scraperAudits").doc("posh");
    const startedAt = Date.now();
    try {
      const leased = await withRunLease(lockId, async () => {
        const summary = await runExtractStage({ name: "posh", scrape: (cache) => parsePoshPayload(req.body?.events, anthropicApiKey.value(), cache) }, lockId,
          { store: firestorePipelineStore(), enqueue: cloudTasksEnqueuer() }, { breaker: false });
        const result = {
          source: "posh",
          status: summary.extracted > 0 || summary.skippedByCache > 0 ? "ok" : "empty",
          count: summary.extracted,
          alreadyExtracted: summary.skippedByCache,
          queued: summary.queued,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          samples: summary.samples ?? [],
          completedAt: Timestamp.now(),
        };
        await auditRef.set(result);
        return result;
      });
      res.json(leased.duplicate ? { source: "posh", status: "duplicate" } : leased.result);
    } catch (error) {
      if (error instanceof LeaseBusyError) {
        res.status(503).json({ source: "posh", status: "busy", error: "Retry this delivery later" });
        return;
      }
      const result = {
        source: "posh", status: "error", error: String(error),
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), completedAt: Timestamp.now(),
      };
      await auditRef.set(result);
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
      invoker: "private",
      retryConfig: queue.retryConfig,
      rateLimits: queue.rateLimits,
      timeoutSeconds: queue.timeoutSeconds,
      secrets: stage === "write" ? [anthropicApiKey] : [],
    },
    async (request) => {
      const deps = stageDeps(stage === "write" ? anthropicApiKey.value() : "");
      const task = parseStageTask(request.data);
      const result = await runWithDeadLetter(
        stage, task, request.retryCount, queue.retryConfig.maxAttempts, deps
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
    if (!isAdminToken(token)) {
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
