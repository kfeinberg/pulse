import { createHash } from "node:crypto";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { EXTRACTION_MODEL, EXTRACTION_PROMPT } from "./extractionPrompt.js";

// Remembers which source items have already been through the Claude
// extraction pass, so each scrape only pays to extract new or changed items.
// Skipping a seen item loses nothing: its events are already in Firestore,
// and dailyCleanup removes them only once they have ended.
//
// An item's key is a SHA-256 of the exact text Claude would see, together
// with the model and prompt. Any edit to the item, the prompt or the model
// produces a new key, so the item is extracted again. Bump CACHE_VERSION to
// force a full re-extraction after changing parser post-processing.
const CACHE_VERSION = 1;
const COLLECTION = "_extractionCache";
const CACHE_TTL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EXTRACTOR_FINGERPRINT = sha256(`${EXTRACTION_MODEL}\n${EXTRACTION_PROMPT}`);

// Whitespace-only differences (re-indented HTML, trailing newlines) should
// not count as a change to the item.
export function normalizeItemText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function itemKey(
  sourceName: string,
  text: string,
  extractorFingerprint = EXTRACTOR_FINGERPRINT
): string {
  return sha256(
    [CACHE_VERSION, extractorFingerprint, sourceName, normalizeItemText(text)].join("\n")
  );
}

export interface SeenItemStore {
  findExisting(keys: string[]): Promise<Set<string>>;
  save(keys: string[], sourceName: string): Promise<void>;
}

const firestoreSeenItemStore: SeenItemStore = {
  async findExisting(keys) {
    const db = getFirestore();
    const existing = new Set<string>();
    const now = Date.now();
    for (let i = 0; i < keys.length; i += 100) {
      const refs = keys.slice(i, i + 100).map((key) => db.collection(COLLECTION).doc(key));
      const snapshots = await db.getAll(...refs);
      for (const snapshot of snapshots) {
        // dailyCleanup deletes expired entries, but one may expire in between.
        const expiresAt = snapshot.get("expiresAt") as Timestamp | undefined;
        if (snapshot.exists && (!expiresAt || expiresAt.toMillis() > now)) {
          existing.add(snapshot.id);
        }
      }
    }
    return existing;
  },

  async save(keys, sourceName) {
    const db = getFirestore();
    const extractedAt = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(extractedAt.toMillis() + CACHE_TTL_DAYS * DAY_MS);
    for (let i = 0; i < keys.length; i += 500) {
      const batch = db.batch();
      for (const key of keys.slice(i, i + 500)) {
        batch.set(db.collection(COLLECTION).doc(key), { sourceName, extractedAt, expiresAt });
      }
      await batch.commit();
    }
  },
};

export async function deleteExpiredExtractionCache(): Promise<number> {
  const db = getFirestore();
  const snapshot = await db
    .collection(COLLECTION)
    .where("expiresAt", "<", Timestamp.now())
    .get();
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const batch = db.batch();
    for (const doc of snapshot.docs.slice(i, i + 500)) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }
  return snapshot.size;
}

export interface NewItems<T> {
  items: T[];
  texts: string[];
  keys: string[];
}

// One instance per source per run. Keys are written only by commit(), which
// the caller runs once the extracted events are safely stored, so an item
// whose extraction or write failed is extracted again next run.
export class ExtractionCache {
  private readonly staged = new Set<string>();
  private skippedCount = 0;
  private seenCount = 0;

  constructor(
    readonly sourceName: string,
    private readonly options: { force?: boolean; store?: SeenItemStore } = {}
  ) {}

  // Items already extracted in this run or a previous one.
  get skipped(): number {
    return this.skippedCount;
  }

  // Every item offered for extraction, new or not: how much the source listed.
  get seen(): number {
    return this.seenCount;
  }

  // Returns the items that have not been extracted before, with the text to
  // send to Claude. With force, every item counts as new.
  async filterNew<T>(items: T[], toText: (item: T) => string): Promise<NewItems<T>> {
    this.seenCount += items.length;
    const texts = items.map(toText);
    const keys = texts.map((text) => itemKey(this.sourceName, text));
    const seen =
      this.options.force || keys.length === 0
        ? new Set<string>()
        : await (this.options.store ?? firestoreSeenItemStore).findExisting(keys);

    const fresh: NewItems<T> = { items: [], texts: [], keys: [] };
    const pending = new Set<string>();
    items.forEach((item, index) => {
      const key = keys[index];
      if (seen.has(key) || this.staged.has(key) || pending.has(key)) {
        this.skippedCount++;
        return;
      }
      pending.add(key);
      fresh.items.push(item);
      fresh.texts.push(texts[index]);
      fresh.keys.push(key);
    });

    console.log(
      `${this.sourceName}: ${fresh.items.length}/${items.length} items are new since their last extraction`
    );
    return fresh;
  }

  // Marks keys whose extraction succeeded; they are saved by commit().
  stage(keys: string[]): void {
    for (const key of keys) this.staged.add(key);
  }

  async commit(): Promise<number> {
    const keys = [...this.staged];
    if (keys.length > 0) {
      await (this.options.store ?? firestoreSeenItemStore).save(keys, this.sourceName);
    }
    this.staged.clear();
    return keys.length;
  }
}
