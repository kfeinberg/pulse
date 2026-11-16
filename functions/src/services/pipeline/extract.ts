import type { EventSource, ScrapedEvent } from "../../scrapers/base.js";
import { ExtractionCache } from "../extractionCache.js";
import { itemId, type ExtractCheckpoint, type PipelineStore, type Stage } from "./checkpoints.js";
import { evaluateSourceHealth, HISTORY_RUNS, type SourceHealth } from "./circuitBreaker.js";
import type { StageTask } from "./stages.js";

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
  samples?: Array<Pick<ScrapedEvent, "title" | "location" | "sourceUrl">>;
}
async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function finishExtraction(checkpoint: ExtractCheckpoint, cache: ExtractionCache, runId: string, deps: ExtractDeps): Promise<SourceRunSummary> {
  const { summary, itemIds } = checkpoint;
  if (summary.health.tripped) {
    await inBatches(itemIds, 20, (inputId) => deps.store.quarantine({
      stage: "gate", inputId, source: summary.source, runId, reason: `circuit breaker: ${summary.health.reason}`,
    }));
  } else {
    await inBatches(itemIds, 10, (inputId) => deps.enqueue("gate", { inputId }));
    cache.stage(checkpoint.cacheKeys);
    await cache.commit();
    if (checkpoint.breaker) await deps.store.recordSourceCount(summary.source, summary.listed, HISTORY_RUNS, runId);
  }
  return summary;
}

// The extraction result is durable before *any* enqueue. A source retry uses
// exactly those outputs and cache keys, even if the LLM would now differ.
export async function checkpointExtracted(
  source: string, events: ScrapedEvent[], cache: ExtractionCache, runId: string,
  deps: ExtractDeps, options: { breaker: boolean }
): Promise<SourceRunSummary> {
  const existing = await deps.store.getExtractRun(runId, source);
  if (existing) return finishExtraction(existing, cache, runId, deps);
  // Count raw source items, never expanded roundup events, across cache hits.
  const listed = cache.seen > 0 ? cache.seen : events.length;
  const health = options.breaker ? evaluateSourceHealth(listed, await deps.store.sourceHistory(source)) : { tripped: false };
  const createdAtMs = (deps.now ?? Date.now)();
  const ids = events.map((event) => itemId(source, event, undefined, runId));
  await inBatches(events.map((event, i) => ({ event, id: ids[i] })), 20, ({ event, id }) =>
    deps.store.put("items", { id, source, runId, createdAtMs, held: health.tripped, data: { event } })
  );
  const checkpoint = await deps.store.saveExtractRun(runId, source, {
    itemIds: ids, cacheKeys: cache.stagedKeys, breaker: options.breaker,
    summary: {
      source, listed, extracted: events.length, skippedByCache: cache.skipped,
      queued: health.tripped ? 0 : ids.length, held: health.tripped ? ids.length : 0, health,
      samples: events.slice(0, 5).map(({ title, location, sourceUrl }) => ({ title, location, sourceUrl })),
    },
  });
  return finishExtraction(checkpoint, cache, runId, deps);
}

export async function runExtractStage(
  source: EventSource, runId: string, deps: ExtractDeps, options: { force?: boolean; breaker?: boolean } = {}
): Promise<SourceRunSummary> {
  const cache = new ExtractionCache(source.name, { force: options.force });
  const existing = await deps.store.getExtractRun(runId, source.name);
  if (existing) return finishExtraction(existing, cache, runId, deps);
  const events = await source.scrape(cache);
  return checkpointExtracted(source.name, events, cache, runId, deps, { breaker: options.breaker !== false });
}
