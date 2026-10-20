import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtractionCache,
  itemKey,
  normalizeItemText,
  type SeenItemStore,
} from "./extractionCache.js";

function memoryStore(): SeenItemStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    async findExisting(keys) {
      return new Set(keys.filter((key) => saved.has(key)));
    },
    async save(keys, sourceName) {
      for (const key of keys) saved.set(key, sourceName);
    },
  };
}

const identity = (text: string) => text;

test("normalizeItemText ignores whitespace-only differences", () => {
  assert.equal(normalizeItemText("  Event: A\n\n  Start:   7pm \n"), "Event: A Start: 7pm");
  assert.equal(itemKey("dice", "Event: A\nStart: 7pm"), itemKey("dice", "Event: A   Start: 7pm"));
});

test("itemKey changes with the text, the source and the extractor", () => {
  const key = itemKey("dice", "Event: A");
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, itemKey("dice", "Event: B"));
  assert.notEqual(key, itemKey("posh", "Event: A"));
  assert.notEqual(key, itemKey("dice", "Event: A", "different-prompt"));
});

test("skips items committed by an earlier run", async () => {
  const store = memoryStore();
  const first = new ExtractionCache("dice", { store });
  const fresh = await first.filterNew(["a", "b"], identity);
  assert.deepEqual(fresh.items, ["a", "b"]);
  first.stage(fresh.keys);
  await first.commit();

  const second = new ExtractionCache("dice", { store });
  const next = await second.filterNew(["a", "b", "c"], identity);
  assert.deepEqual(next.items, ["c"]);
  assert.equal(second.skipped, 2);
});

test("does not save keys that were never staged", async () => {
  const store = memoryStore();
  const cache = new ExtractionCache("dice", { store });
  await cache.filterNew(["a"], identity);
  assert.equal(await cache.commit(), 0);
  assert.equal(store.saved.size, 0);

  const retry = new ExtractionCache("dice", { store });
  assert.deepEqual((await retry.filterNew(["a"], identity)).items, ["a"]);
});

test("skips duplicates within one run", async () => {
  const cache = new ExtractionCache("fieldnotes", { store: memoryStore() });
  const first = await cache.filterNew(["post", "post"], identity);
  assert.deepEqual(first.items, ["post"]);
  cache.stage(first.keys);
  assert.deepEqual((await cache.filterNew(["post"], identity)).items, []);
});

test("force treats every item as new but still records it", async () => {
  const store = memoryStore();
  const seed = new ExtractionCache("dice", { store });
  seed.stage((await seed.filterNew(["a"], identity)).keys);
  await seed.commit();

  const forced = new ExtractionCache("dice", { store, force: true });
  const fresh = await forced.filterNew(["a"], identity);
  assert.deepEqual(fresh.items, ["a"]);
  forced.stage(fresh.keys);
  assert.equal(await forced.commit(), 1);
});
