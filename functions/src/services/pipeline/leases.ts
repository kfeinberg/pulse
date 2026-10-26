import { randomUUID } from "node:crypto";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

export class LeaseBusyError extends Error {
  constructor(key: string) {
    super(`Work is already running: ${key}`);
    this.name = "LeaseBusyError";
  }
}

export interface LeaseStore {
  claim(key: string, token: string, nowMs: number, expiresAtMs: number): Promise<boolean>;
  finish(key: string, token: string, completed: boolean): Promise<void>;
}

export function firestoreLeaseStore(db: Firestore = getFirestore()): LeaseStore {
  return {
    async claim(key, token, nowMs, expiresAtMs) {
      const ref = db.collection("_runLocks").doc(key);
      return db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data();
        if (data?.status === "completed" && data.expiresAt?.toMillis() > nowMs) return false;
        if (data?.status === "running" && data.expiresAt?.toMillis() > nowMs) throw new LeaseBusyError(key);
        tx.set(ref, { token, status: "running", startedAt: Timestamp.fromMillis(nowMs), expiresAt: Timestamp.fromMillis(expiresAtMs) });
        return true;
      });
    },
    async finish(key, token, completed) {
      const ref = db.collection("_runLocks").doc(key);
      await db.runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data();
        // A worker whose lease expired must never finish a newer worker's claim.
        if (data?.token !== token) return;
        if (completed) tx.update(ref, { status: "completed", finishedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 14 * 24 * 60 * 60_000) });
        else tx.delete(ref);
      });
    },
  };
}

export async function withRunLease<T>(
  key: string,
  operation: () => Promise<T>,
  options: { store?: LeaseStore; now?: () => number; leaseMs?: number; retainCompleted?: boolean } = {}
): Promise<{ duplicate: true } | { duplicate: false; result: T }> {
  const store = options.store ?? firestoreLeaseStore();
  const token = randomUUID();
  const now = (options.now ?? Date.now)();
  if (!(await store.claim(key, token, now, now + (options.leaseMs ?? 35 * 60_000)))) return { duplicate: true };
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return { duplicate: false, result };
  } finally {
    await store.finish(key, token, succeeded && options.retainCompleted !== false);
  }
}

// Cloud Tasks concurrency limits normally serialize these stages. A lease also
// covers redeliveries after a timeout and overlapping function instances.
export async function withStageLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = await withRunLease(key, operation, { leaseMs: 6 * 60_000, retainCompleted: false });
  if (result.duplicate) throw new LeaseBusyError(key);
  return result.result;
}
