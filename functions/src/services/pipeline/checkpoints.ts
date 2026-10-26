import { createHash } from "node:crypto";
import { getFirestore, Timestamp, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { SourceRunSummary } from "./extract.js";

// The pipeline runs as stages that hand off through checkpoints in Firestore:
//
//   extract ──► pipeline_items ──► gate ──► pipeline_accepted ──► geocode
//           ──► pipeline_pinned ──► write ──► events (+ pipeline_written)
//
// Each stage reads its input checkpoint, never in-memory state, so any stage
// can be rerun on its own from the checkpoint before it. Checkpoint ids hash
// the stage, the stage's version and the upstream id: a redelivered task
// rewrites the same document, and bumping a stage's version gives its outputs
// (and everything downstream) fresh ids when replayed.

export type Stage = "gate" | "geocode" | "write";
export const STAGES: readonly Stage[] = ["gate", "geocode", "write"];

// Bump a stage's version when its logic changes, then replay that stage.
export const STAGE_VERSIONS = { extract: 2, gate: 2, geocode: 2, write: 2 } as const;

export const COLLECTIONS = {
  items: "pipeline_items",
  accepted: "pipeline_accepted",
  pinned: "pipeline_pinned",
  written: "pipeline_written",
  quarantine: "pipeline_quarantine",
  sources: "pipeline_sources",
  runs: "pipeline_runs",
} as const;
export type CheckpointCollection = "items" | "accepted" | "pinned" | "written";

export const STAGE_INPUT: Record<Stage, CheckpointCollection> = { gate: "items", geocode: "accepted", write: "pinned" };
export const STAGE_OUTPUT: Record<Stage, CheckpointCollection> = { gate: "accepted", geocode: "pinned", write: "written" };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// JSON with sorted keys, so the same event always hashes the same way.
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function itemId(source: string, event: unknown, version: number = STAGE_VERSIONS.extract, runId = ""): string {
  return sha256(`extract|v${version}|${source}|${runId}|${stableJson(event)}`).slice(0, 40);
}

export function checkpointId(stage: Stage, upstreamId: string, version: number = STAGE_VERSIONS[stage], replayId = ""): string {
  return sha256(`${stage}|v${version}|${upstreamId}|${replayId}`).slice(0, 40);
}

export interface CheckpointDoc {
  id: string;
  source: string;
  runId: string;
  createdAtMs: number;
  // Item held back by the source's circuit breaker; released by a replay.
  held?: boolean;
  data: Record<string, unknown>;
}

export interface QuarantineEntry {
  stage: Stage;
  inputId: string;
  source: string;
  runId: string;
  reason: string;
}

export interface StoredQuarantineEntry extends QuarantineEntry {
  id: string;
  createdAtMs: number;
  released: boolean;
}

export interface ExtractCheckpoint {
  itemIds: string[];
  cacheKeys: string[];
  breaker: boolean;
  summary: SourceRunSummary;
}

export interface PipelineStore {
  getExtractRun(runId: string, source: string): Promise<ExtractCheckpoint | null>;
  saveExtractRun(runId: string, source: string, checkpoint: ExtractCheckpoint): Promise<ExtractCheckpoint>;
  get(collection: CheckpointCollection, id: string): Promise<CheckpointDoc | null>;
  put(collection: CheckpointCollection, doc: CheckpointDoc): Promise<void>;
  setHeld(id: string, held: boolean): Promise<void>;
  list(collection: CheckpointCollection, sinceMs: number, untilMs: number, limit?: number, source?: string): Promise<CheckpointDoc[]>;
  quarantine(entry: QuarantineEntry): Promise<void>;
  getQuarantine(stage: Stage, inputId: string): Promise<StoredQuarantineEntry | null>;
  listQuarantine(stage: Stage, sinceMs: number, limit?: number, filters?: { untilMs?: number; source?: string }): Promise<StoredQuarantineEntry[]>;
  markReleased(quarantineId: string): Promise<void>;
  sourceHistory(source: string): Promise<number[]>;
  recordSourceCount(source: string, listed: number, keep: number, runId?: string): Promise<void>;
}

export function quarantineId(stage: Stage, inputId: string): string {
  return sha256(`quarantine|${stage}|${inputId}`).slice(0, 40);
}

export function firestorePipelineStore(db: Firestore = getFirestore()): PipelineStore {
  const col = (name: CheckpointCollection) => db.collection(COLLECTIONS[name]);
  const toDoc = (id: string, raw: FirebaseFirestore.DocumentData): CheckpointDoc => ({
    id,
    source: raw.source,
    runId: raw.runId,
    createdAtMs: (raw.createdAt as Timestamp).toMillis(),
    held: raw.held === true,
    data: raw.data ?? {},
  });

  return {
    async getExtractRun(runId, source) {
      const snap = await db.collection(COLLECTIONS.runs).doc(runId).get();
      return snap.data()?.extractions?.[source] ?? null;
    },
    async saveExtractRun(runId, source, checkpoint) {
      const ref = db.collection(COLLECTIONS.runs).doc(runId);
      return db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data();
        const existing = data?.extractions?.[source];
        if (existing) return existing as ExtractCheckpoint;
        const saved = JSON.parse(JSON.stringify(checkpoint)) as ExtractCheckpoint;
        tx.set(ref, { createdAt: data?.createdAt ?? Timestamp.now(), extractions: { [source]: saved } }, { merge: true });
        return saved;
      });
    },
    async get(collection, id) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(col(collection).doc(id));
        if (!snap.exists) return null;
        const input = toDoc(snap.id, snap.data()!);
        const touched = [snap];
        let current = snap;
        let currentCollection = collection;
        const parent: Partial<Record<CheckpointCollection, CheckpointCollection>> = { accepted: "items", pinned: "accepted", written: "pinned" };
        // Touch the whole ancestry in one transaction. Cleanup uses snapshot
        // update-time preconditions, so a replay cannot lose an ancestor.
        while (parent[currentCollection] && typeof current.data()?.data?.inputId === "string") {
          currentCollection = parent[currentCollection]!;
          const upstream = await tx.get(col(currentCollection).doc(current.data()!.data.inputId));
          if (!upstream.exists) break;
          touched.push(upstream);
          current = upstream;
        }
        const lastUsedAt = Timestamp.now();
        for (const doc of touched) tx.update(doc.ref, { lastUsedAt });
        return input;
      });
    },
    async put(collection, doc) {
      // Checkpoint identity includes the operation. Never replace a snapshot
      // another worker or downstream stage may already have consumed.
      try {
        await col(collection).doc(doc.id).create({
          source: doc.source,
          runId: doc.runId,
          createdAt: Timestamp.fromMillis(doc.createdAtMs),
          held: doc.held === true,
          data: JSON.parse(JSON.stringify(doc.data)),
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 6) throw error;
      }
    },
    async setHeld(id, held) {
      await col("items").doc(id).update({ held });
    },
    async list(collection, sinceMs, untilMs, limit = 1001, source) {
      let query = col(collection)
        .where("createdAt", ">=", Timestamp.fromMillis(sinceMs))
        .where("createdAt", "<=", Timestamp.fromMillis(untilMs));
      if (source) query = query.where("source", "==", source);
      const snap = await query.limit(limit).get();
      return snap.docs.map((d) => toDoc(d.id, d.data()));
    },
    async quarantine(entry) {
      await db.collection(COLLECTIONS.quarantine).doc(quarantineId(entry.stage, entry.inputId)).set({
        ...entry,
        createdAt: Timestamp.now(),
        released: false,
      });
    },
    async getQuarantine(stage, inputId) {
      const snap = await db.collection(COLLECTIONS.quarantine).doc(quarantineId(stage, inputId)).get();
      if (!snap.exists) return null;
      const raw = snap.data()!;
      return { ...(raw as QuarantineEntry), id: snap.id, createdAtMs: (raw.createdAt as Timestamp).toMillis(), released: raw.released === true };
    },
    async listQuarantine(stage, sinceMs, limit = 1001, filters = {}) {
      let query = db.collection(COLLECTIONS.quarantine)
        .where("stage", "==", stage)
        .where("released", "==", false)
        .where("createdAt", ">=", Timestamp.fromMillis(sinceMs));
      if (filters.untilMs !== undefined) query = query.where("createdAt", "<=", Timestamp.fromMillis(filters.untilMs));
      if (filters.source) query = query.where("source", "==", filters.source);
      const snap = await query.limit(limit).get();
      return snap.docs
        .map((d) => {
          const raw = d.data();
          return { ...(raw as QuarantineEntry), id: d.id, createdAtMs: (raw.createdAt as Timestamp).toMillis(), released: raw.released === true };
        })
        .filter((entry) => entry.stage === stage);
    },
    async markReleased(id) {
      const ref = db.collection(COLLECTIONS.quarantine).doc(id);
      await db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).exists) tx.update(ref, { released: true, releasedAt: Timestamp.now() });
      });
    },
    async sourceHistory(source) {
      const snap = await db.collection(COLLECTIONS.sources).doc(source).get();
      const data = snap.data();
      const history = data?.countVersion === 2 ? data.history : [];
      return Array.isArray(history) ? history.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0) : [];
    },
    async recordSourceCount(source, listed, keep, runId) {
      const ref = db.collection(COLLECTIONS.sources).doc(source);
      await db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data();
        const history = data?.countVersion === 2 && Array.isArray(data.history) ? data.history.filter((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0) as number[] : [];
        const runs = data?.countVersion === 2 && Array.isArray(data.runs) ? data.runs as string[] : [];
        // Retrying a partially successful multi-source run must not give its
        // healthy sources extra weight in the seven-run baseline.
        if (runId && runs.includes(runId)) return;
        tx.set(ref, {
          countVersion: 2, // v1 mixed extracted-event and raw-item counts.
          history: [...history, listed].slice(-keep),
          runs: runId ? [...runs, runId].slice(-keep) : runs,
          updatedAt: Timestamp.now(),
        }, { merge: true });
      });
    },
  };
}

// Retain ancestors of recent checkpoints/quarantine entries so a replayable
// output never outlives its input. Old, unreferenced snapshots still expire.
export function checkpointDeletionPlan(
  docs: Array<{ collection: string; id: string; createdAtMs: number; data: Record<string, unknown>; runId?: string; stage?: unknown; inputId?: unknown }>,
  cutoffMs: number
): Set<string> {
  const key = (collection: string, id: string) => `${collection}/${id}`;
  const byKey = new Map(docs.map((doc) => [key(doc.collection, doc.id), doc]));
  const retained = new Set<string>();
  const parents: Record<string, string> = {
    [COLLECTIONS.accepted]: COLLECTIONS.items,
    [COLLECTIONS.pinned]: COLLECTIONS.accepted,
    [COLLECTIONS.written]: COLLECTIONS.pinned,
  };
  const retain = (doc: typeof docs[number]) => {
    const id = key(doc.collection, doc.id);
    if (retained.has(id)) return;
    retained.add(id);
    if (doc.collection === COLLECTIONS.runs && doc.data.extractions && typeof doc.data.extractions === "object") {
      for (const extraction of Object.values(doc.data.extractions as Record<string, ExtractCheckpoint>)) {
        for (const inputId of extraction.itemIds ?? []) {
          const item = byKey.get(key(COLLECTIONS.items, inputId));
          if (item) retain(item);
        }
      }
    }
    const inputId = doc.collection === COLLECTIONS.quarantine ? doc.inputId : doc.data.inputId;
    const parent = doc.collection === COLLECTIONS.quarantine && STAGES.includes(doc.stage as Stage)
      ? COLLECTIONS[STAGE_INPUT[doc.stage as Stage]] : parents[doc.collection];
    if (parent && typeof inputId === "string") {
      const upstream = byKey.get(key(parent, inputId));
      if (upstream) retain(upstream);
    }
    if (doc.runId) {
      const run = byKey.get(key(COLLECTIONS.runs, doc.runId));
      if (run) retain(run);
    }
  };
  for (const doc of docs) if (doc.createdAtMs >= cutoffMs) retain(doc);
  return new Set(docs.filter((doc) => doc.createdAtMs < cutoffMs && !retained.has(key(doc.collection, doc.id))).map((doc) => key(doc.collection, doc.id)));
}

export async function deleteExpiredRunLocks(db: Firestore, nowMs = Date.now()): Promise<number> {
  const snapshot = await db.collection("_runLocks").where("expiresAt", "<", Timestamp.fromMillis(nowMs)).get();
  let deleted = 0;
  for (const doc of snapshot.docs) {
    const removed = await db.runTransaction(async (tx) => {
      const current = (await tx.get(doc.ref)).data();
      // The expired query snapshot is not a delete authorization: a new
      // worker may have acquired this document since the query completed.
      if (!current?.expiresAt || current.expiresAt.toMillis() >= nowMs) return false;
      tx.delete(doc.ref);
      return true;
    });
    if (removed) deleted++;
  }
  return deleted;
}

async function deleteUnchangedCheckpoints(docs: QueryDocumentSnapshot[], db: Firestore): Promise<number> {
  const batch = db.batch();
  for (const doc of docs) batch.delete(doc.ref, { lastUpdateTime: doc.updateTime });
  try {
    await batch.commit();
    return docs.length;
  } catch (error) {
    if (![5, 9].includes((error as { code?: number }).code ?? -1)) throw error;
    // A replay touched one member after the cleanup scan. The failed batch
    // changed nothing; delete only individually unchanged snapshots now.
    let deleted = 0;
    for (const doc of docs) {
      try { await doc.ref.delete({ lastUpdateTime: doc.updateTime }); deleted++; }
      catch (err) { if (![5, 9].includes((err as { code?: number }).code ?? -1)) throw err; }
    }
    return deleted;
  }
}

export async function deleteOldCheckpoints(maxAgeDays: number, db: Firestore = getFirestore()): Promise<number> {
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const names = [COLLECTIONS.items, COLLECTIONS.accepted, COLLECTIONS.pinned, COLLECTIONS.written, COLLECTIONS.quarantine, COLLECTIONS.runs];
  const snapshots = await Promise.all(names.map(async (collection) => ({ collection, snap: await db.collection(collection)
    .select("createdAt", "lastUsedAt", "data.inputId", "inputId", "runId", "stage", "extractions").get() })));
  const records = snapshots.flatMap(({ collection, snap }) => snap.docs.map((doc) => {
    const raw = doc.data();
    return { collection, id: doc.id, createdAtMs: Math.max(raw.createdAt.toMillis(), raw.lastUsedAt?.toMillis() ?? 0), data: collection === COLLECTIONS.runs ? { extractions: raw.extractions } : raw.data ?? {}, runId: raw.runId, stage: raw.stage, inputId: raw.inputId };
  }));
  const remove = checkpointDeletionPlan(records, cutoffMs);
  let deleted = 0;
  for (const { collection, snap } of snapshots) {
    const obsolete = snap.docs.filter((doc) => remove.has(`${collection}/${doc.id}`));
    for (let i = 0; i < obsolete.length; i += 500) {
      deleted += await deleteUnchangedCheckpoints(obsolete.slice(i, i + 500), db);
    }
  }
  // Run locks have their own expiry, including completed Posh payload claims.
  return deleted + await deleteExpiredRunLocks(db);
}
