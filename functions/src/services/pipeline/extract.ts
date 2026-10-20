import type { EventSource, ScrapedEvent } from "../../scrapers/base.js";
import { ExtractionCache } from "../extractionCache.js";
import { itemId, type PipelineStore, type Stage } from "./checkpoints.js";
import { evaluateSourceHealth, HISTORY_RUNS, type SourceHealth } from "./circuitBreaker.js";
import type { StageTask } from "./stages.js";

// The extract stage: fetch + extract one source, save every extracted event
// as an item checkpoint, and queue each item for the gate on its own. From
// here on an item moves through the pipeline independently of its source run.

export interface ExtractDeps {
  store: PipelineStore;
  enqueue(stage: Stage, task: StageTask): Promise<void>;
  now?: () => number;
}

export interface SourceRunSummary {
  source: string;
  listed: number;
  extracted: number;
  skippedByCache: number;
  queued: number;
  held: number;
  health: SourceHealth;
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// Saves extracted events as item checkpoints. When the source's breaker
// trips, the items are saved but held and quarantined instead of queued, and
// the extraction cache is not committed, so tomorrow's run extracts them again
// if nobody releases them.
export async function checkpointExtracted(
  source: string,
  events: ScrapedEvent[],
  cache: ExtractionCache,
  runId: string,
  deps: ExtractDeps,
  options: { breaker: boolean }
): Promise<SourceRunSummary> {
  const listed = Math.max(cache.seen, events.length);
  const health = options.breaker
    ? evaluateSourceHealth(listed, await deps.store.sourceHistory(source))
    : { tripped: false };
  const createdAtMs = (deps.now ?? Date.now)();

  const ids = events.map((event) => itemId(source, event));
  await inBatches(events.map((event, i) => ({ event, id: ids[i] })), 20, ({ event, id }) =>
    deps.store.put("items", { id, source, runId, createdAtMs, held: health.tripped, data: { event } })
  );

  if (health.tripped) {
    console.warn(`[extract] circuit breaker open for ${source}: ${health.reason}`);
    await inBatches(ids, 20, (id) =>
      deps.store.quarantine({ stage: "gate", inputId: id, source, runId, reason: `circuit breaker: ${health.reason}` })
    );
  } else {
    await inBatches(ids, 10, (id) => deps.enqueue("gate", { inputId: id }));
    // Items are durable now, so later stages retry from their checkpoints.
    await cache.commit();
    if (options.breaker) await deps.store.recordSourceCount(source, listed, HISTORY_RUNS);
  }

  return {
    source,
    listed,
    extracted: events.length,
    skippedByCache: cache.skipped,
    queued: health.tripped ? 0 : ids.length,
    held: health.tripped ? ids.length : 0,
    health,
  };
}

export async function runExtractStage(
  source: EventSource,
  runId: string,
  deps: ExtractDeps,
  options: { force?: boolean } = {}
): Promise<SourceRunSummary> {
  const cache = new ExtractionCache(source.name, { force: options.force });
  const events = await source.scrape(cache);
  return checkpointExtracted(source.name, events, cache, runId, deps, { breaker: true });
}
