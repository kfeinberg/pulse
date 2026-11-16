import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import { firestoreLeaseStore, LeaseBusyError, withRunLease } from "./leases.js";

function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (id: string) => ({ id });
  const tx = {
    get: async (r: { id: string }) => ({ data: () => docs.get(r.id) }),
    set: (r: { id: string }, data: Record<string, unknown>) => { docs.set(r.id, data); },
    update: (r: { id: string }, data: Record<string, unknown>) => { docs.set(r.id, { ...docs.get(r.id), ...data }); },
    delete: (r: { id: string }) => { docs.delete(r.id); },
  };
  let tail = Promise.resolve();
  const db = {
    collection: () => ({ doc: ref }),
    runTransaction: <T>(fn: (t: typeof tx) => Promise<T>) => {
      const result = tail.then(() => fn(tx));
      tail = result.then(() => {}, () => {});
      return result;
    },
  } as unknown as Firestore;
  return { docs, store: firestoreLeaseStore(db) };
}

test("busy run deliveries retry; failed work releases the claim for a real retry", async () => {
  const { docs, store } = fakeFirestore();
  await assert.rejects(withRunLease("run", async () => {
    await assert.rejects(store.claim("run", "duplicate", 10, 100), LeaseBusyError);
    throw new Error("extraction failed");
  }, { store, now: () => 0, leaseMs: 100 }), /extraction failed/);
  assert.equal(docs.has("run"), false);
  const result = await withRunLease("run", async () => 42, { store });
  assert.deepEqual(result, { duplicate: false, result: 42 });
  assert.deepEqual(await withRunLease("run", async () => { throw new Error("must not execute"); }, { store }), { duplicate: true });
});

test("an expired worker cannot complete or delete a replacement lease", async () => {
  const { docs, store } = fakeFirestore();
  assert.equal(await store.claim("run", "old", 0, 10), true);
  assert.equal(await store.claim("run", "new", 11, 100), true);
  await store.finish("run", "old", true);
  await store.finish("run", "old", false);
  assert.equal(docs.get("run")!.token, "new");
  assert.equal(docs.get("run")!.status, "running");
  await store.finish("run", "new", false);
  assert.equal(docs.has("run"), false);
});

test("stage-style leases release on success instead of suppressing later work", async () => {
  const { docs, store } = fakeFirestore();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await withRunLease("pipeline-write", async () => i, { store, retainCompleted: false }), { duplicate: false, result: i });
    assert.equal(docs.size, 0);
  }
});
