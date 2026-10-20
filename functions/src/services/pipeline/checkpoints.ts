import { createHash } from "node:crypto";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

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
export const STAGE_VERSIONS = { extract: 1, gate: 1, geocode: 1, write: 1 } as const;

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

export function itemId(source: string, event: unknown, version: number = STAGE_VERSIONS.extract): string {
  return sha256(`extract|v${version}|${source}|${stableJson(event)}`).slice(0, 40);
}

export function checkpointId(stage: Stage, upstreamId: string, version: number = STAGE_VERSIONS[stage]): string {
  return sha256(`${stage}|v${version}|${upstreamId}`).slice(0, 40);
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

export interface PipelineStore {
  get(collection: CheckpointCollection, id: string): Promise<CheckpointDoc | null>;
  put(collection: CheckpointCollection, doc: CheckpointDoc): Promise<void>;
  setHeld(id: string, held: boolean): Promise<void>;
  list(collection: CheckpointCollection, sinceMs: number, untilMs: number): Promise<CheckpointDoc[]>;
  quarantine(entry: QuarantineEntry): Promise<void>;
  listQuarantine(stage: Stage, sinceMs: number): Promise<StoredQuarantineEntry[]>;
  markReleased(quarantineId: string): Promise<void>;
  sourceHistory(source: string): Promise<number[]>;
  recordSourceCount(source: string, listed: number, keep: number): Promise<void>;
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
    async get(collection, id) {
      const snap = await col(collection).doc(id).get();
      return snap.exists ? toDoc(snap.id, snap.data()!) : null;
    },
    async put(collection, doc) {
      await col(collection).doc(doc.id).set({
        source: doc.source,
        runId: doc.runId,
        createdAt: Timestamp.fromMillis(doc.createdAtMs),
        held: doc.held === true,
        data: doc.data,
      });
    },
    async setHeld(id, held) {
      await col("items").doc(id).update({ held });
    },
    async list(collection, sinceMs, untilMs) {
      const snap = await col(collection)
        .where("createdAt", ">=", Timestamp.fromMillis(sinceMs))
        .where("createdAt", "<=", Timestamp.fromMillis(untilMs))
        .get();
      return snap.docs.map((d) => toDoc(d.id, d.data()));
    },
    async quarantine(entry) {
      await db.collection(COLLECTIONS.quarantine).doc(quarantineId(entry.stage, entry.inputId)).set({
        ...entry,
        createdAt: Timestamp.now(),
        released: false,
      });
    },
    async listQuarantine(stage, sinceMs) {
      const snap = await db
        .collection(COLLECTIONS.quarantine)
        .where("createdAt", ">=", Timestamp.fromMillis(sinceMs))
        .get();
      return snap.docs
        .map((d) => {
          const raw = d.data();
          return { ...(raw as QuarantineEntry), id: d.id, createdAtMs: (raw.createdAt as Timestamp).toMillis(), released: raw.released === true };
        })
        .filter((entry) => entry.stage === stage);
    },
    async markReleased(id) {
      await db.collection(COLLECTIONS.quarantine).doc(id).update({ released: true, releasedAt: Timestamp.now() });
    },
    async sourceHistory(source) {
      const snap = await db.collection(COLLECTIONS.sources).doc(source).get();
      const history = snap.data()?.history;
      return Array.isArray(history) ? history.filter((n): n is number => typeof n === "number") : [];
    },
    async recordSourceCount(source, listed, keep) {
      const ref = db.collection(COLLECTIONS.sources).doc(source);
      await db.runTransaction(async (tx) => {
        const history = ((await tx.get(ref)).data()?.history ?? []) as number[];
        tx.set(ref, { history: [...history, listed].slice(-keep), updatedAt: Timestamp.now() }, { merge: true });
      });
    },
  };
}

// Checkpoints are only needed while their events can still be replayed.
export async function deleteOldCheckpoints(maxAgeDays: number, db: Firestore = getFirestore()): Promise<number> {
  const cutoff = Timestamp.fromMillis(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  for (const name of [COLLECTIONS.items, COLLECTIONS.accepted, COLLECTIONS.pinned, COLLECTIONS.written,
                      COLLECTIONS.quarantine, COLLECTIONS.runs]) {
    const snap = await db.collection(name).where("createdAt", "<", cutoff).get();
    for (let i = 0; i < snap.docs.length; i += 500) {
      const batch = db.batch();
      for (const doc of snap.docs.slice(i, i + 500)) batch.delete(doc.ref);
      await batch.commit();
    }
    deleted += snap.size;
  }
  return deleted;
}
