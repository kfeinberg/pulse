import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, deleteExpiredRunLocks, firestorePipelineStore } from "./checkpoints.js";

function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const reference = (collection: string, id: string) => {
    const key = `${collection}/${id}`;
    return {
      id, key, get: async () => ({ id, exists: docs.has(key), data: () => docs.get(key), ref: { id, key } }),
      create: async (data: Record<string, unknown>) => { if (docs.has(key)) throw Object.assign(new Error("exists"), { code: 6 }); docs.set(key, data); },
      update: async (data: Record<string, unknown>) => { if (!docs.has(key)) throw new Error("not found"); docs.set(key, { ...docs.get(key), ...data }); },
      set: async (data: Record<string, unknown>) => { docs.set(key, data); },
    };
  };
  const db = {
    collection: (name: string) => ({ doc: (id: string) => reference(name, id) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
      get: async (ref: ReturnType<typeof reference>) => ref.get(),
      set: (ref: ReturnType<typeof reference>, data: Record<string, unknown>) => { docs.set(ref.key, data); },
      update: (ref: ReturnType<typeof reference>, data: Record<string, unknown>) => { docs.set(ref.key, { ...docs.get(ref.key), ...data }); },
    }),
  } as unknown as Firestore;
  return { docs, store: firestorePipelineStore(db) };
}

test("Firestore checkpoint adapter preserves the first durable snapshot", async () => {
  const { store } = fakeFirestore();
  await store.put("items", { id: "id", source: "test", runId: "first", createdAtMs: 1, data: { event: "first", optional: undefined } });
  await store.put("items", { id: "id", source: "test", runId: "second", createdAtMs: 2, held: true, data: { event: "second" } });
  assert.deepEqual(await store.get("items", "id"), { id: "id", source: "test", runId: "first", createdAtMs: 1, held: false, data: { event: "first" } });
});

test("source history resets old mixed units and counts a retried run only once", async () => {
  const { docs, store } = fakeFirestore();
  docs.set(`${COLLECTIONS.sources}/test`, { history: [30, 30, 30] });
  assert.deepEqual(await store.sourceHistory("test"), []);
  await store.recordSourceCount("test", 1, 7, "run1");
  await store.recordSourceCount("test", 1, 7, "run1");
  await store.recordSourceCount("test", 1, 7, "run2");
  assert.deepEqual(await store.sourceHistory("test"), [1, 1]);
});

test("markReleased tolerates no existing quarantine and records successful recovery", async () => {
  const { docs, store } = fakeFirestore();
  await store.markReleased("missing");
  docs.set(`${COLLECTIONS.quarantine}/q`, { released: false, createdAt: Timestamp.fromMillis(1) });
  await store.markReleased("q");
  assert.equal(docs.get(`${COLLECTIONS.quarantine}/q`)!.released, true);
});

test("expired-lock cleanup cannot delete a lease reclaimed after its query snapshot", async () => {
  let current = { token: "old", expiresAt: Timestamp.fromMillis(1) };
  let deletes = 0;
  const ref = { id: "lock" };
  const db = {
    collection: () => ({ where: () => ({ get: async () => {
      // Query selected the old lease, but another worker has now reclaimed it.
      current = { token: "new", expiresAt: Timestamp.fromMillis(1000) };
      return { docs: [{ ref }] };
    } }) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
      get: async () => ({ data: () => current }),
      delete: () => { deletes++; },
    }),
  } as unknown as Firestore;
  assert.equal(await deleteExpiredRunLocks(db, 10), 0);
  assert.equal(deletes, 0);
  assert.equal(current.token, "new");
});
