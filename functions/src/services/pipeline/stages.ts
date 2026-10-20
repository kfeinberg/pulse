import type { ScrapedEvent } from "../../scrapers/base.js";
import type { ResolvedLocation } from "../geocoder.js";
import type { UpsertOutcome } from "../firestore.js";
import { temporalExclusionReason } from "../temporalFilter.js";
import {
  checkpointId,
  STAGE_INPUT,
  type CheckpointDoc,
  type PipelineStore,
  type Stage,
} from "./checkpoints.js";
import { resolvedLocationViolations, scrapedEventViolations } from "./contracts.js";

// Each task carries only the id of its input checkpoint. replayId marks a
// replay: its tasks get fresh task ids and redo work a normal redelivery
// would skip.
export interface StageTask {
  inputId: string;
  replayId?: string;
}

export interface StageDeps {
  store: PipelineStore;
  enqueue(stage: Stage, task: StageTask): Promise<void>;
  // Throws on a transient failure (the queue retries); null means "no exact place".
  geocode(event: ScrapedEvent): Promise<ResolvedLocation | null>;
  upsert(event: ScrapedEvent, geo: ResolvedLocation | null, addId: string): Promise<UpsertOutcome>;
  now?: () => number;
}

export type StageResult =
  | { status: "done"; outputId: string; detail?: string }
  | { status: "quarantined"; reason: string }
  | { status: "skipped"; reason: string };

async function loadInput(stage: Stage, task: StageTask, deps: StageDeps): Promise<CheckpointDoc | null> {
  return deps.store.get(STAGE_INPUT[stage], task.inputId);
}

async function quarantine(stage: Stage, input: CheckpointDoc, reason: string, deps: StageDeps): Promise<StageResult> {
  await deps.store.quarantine({ stage, inputId: input.id, source: input.source, runId: input.runId, reason });
  console.warn(`[${stage}] quarantined ${input.id} (${input.source}): ${reason}`);
  return { status: "quarantined", reason };
}

function handoff(stage: Stage, input: CheckpointDoc, data: Record<string, unknown>, deps: StageDeps): CheckpointDoc {
  return {
    id: checkpointId(stage, input.id),
    source: input.source,
    runId: input.runId,
    createdAtMs: (deps.now ?? Date.now)(),
    data: { ...data, inputId: input.id },
  };
}

// Gate: schema contract plus the time-bounded check. Anything that fails is
// quarantined with the reason; accepted items go on to geocoding.
export async function runGate(task: StageTask, deps: StageDeps): Promise<StageResult> {
  const input = await loadInput("gate", task, deps);
  if (!input) return { status: "skipped", reason: `input ${task.inputId} not found` };
  if (input.held && !task.replayId) return { status: "skipped", reason: "held by circuit breaker" };

  const event = input.data.event;
  const violations = scrapedEventViolations(event);
  const temporal = violations.length ? null : temporalExclusionReason(event as ScrapedEvent);
  if (violations.length) return quarantine("gate", input, `contract: ${violations.join("; ")}`, deps);
  if (temporal) return quarantine("gate", input, temporal, deps);

  const output = handoff("gate", input, { event }, deps);
  await deps.store.put("accepted", output);
  await deps.enqueue("geocode", { inputId: output.id, replayId: task.replayId });
  return { status: "done", outputId: output.id };
}

// Geocode: resolve an exact pin. A lookup that errors throws so the queue
// retries it; "no exact place" is passed on as null, since the event may
// still merge into an existing one.
export async function runGeocode(task: StageTask, deps: StageDeps): Promise<StageResult> {
  const input = await loadInput("geocode", task, deps);
  if (!input) return { status: "skipped", reason: `input ${task.inputId} not found` };

  const violations = scrapedEventViolations(input.data.event);
  if (violations.length) return quarantine("geocode", input, `contract: ${violations.join("; ")}`, deps);
  const event = input.data.event as ScrapedEvent;

  const geo = await deps.geocode(event);
  const output = handoff("geocode", input, { event, geo }, deps);
  await deps.store.put("pinned", output);
  await deps.enqueue("write", { inputId: output.id, replayId: task.replayId });
  return { status: "done", outputId: output.id, detail: geo ? "pinned" : "no exact location" };
}

// Write: dedup against existing events, then merge or insert. The outcome is
// recorded so a redelivered task is a no-op; a replay always reruns.
export async function runWrite(task: StageTask, deps: StageDeps): Promise<StageResult> {
  const input = await loadInput("write", task, deps);
  if (!input) return { status: "skipped", reason: `input ${task.inputId} not found` };

  const violations = [
    ...scrapedEventViolations(input.data.event),
    ...resolvedLocationViolations(input.data.geo ?? null),
  ];
  if (violations.length) return quarantine("write", input, `contract: ${violations.join("; ")}`, deps);

  const outputId = checkpointId("write", input.id);
  if (!task.replayId && (await deps.store.get("written", outputId))) {
    return { status: "skipped", reason: "already written" };
  }

  const outcome = await deps.upsert(
    input.data.event as ScrapedEvent,
    (input.data.geo ?? null) as ResolvedLocation | null,
    outputId
  );
  await deps.store.put("written", {
    id: outputId,
    source: input.source,
    runId: input.runId,
    createdAtMs: (deps.now ?? Date.now)(),
    data: { inputId: input.id, outcome },
  });
  return { status: "done", outputId, detail: outcome.kind };
}

export const STAGE_RUNNERS: Record<Stage, (task: StageTask, deps: StageDeps) => Promise<StageResult>> = {
  gate: runGate,
  geocode: runGeocode,
  write: runWrite,
};

// Dead-letter handling: a failure is rethrown (so the queue retries with
// backoff) until the last attempt, which quarantines the input with the error
// instead, so one bad item stops retrying without blocking anything else.
export async function runWithDeadLetter(
  stage: Stage,
  task: StageTask,
  attempt: number,
  maxAttempts: number,
  deps: StageDeps
): Promise<StageResult> {
  try {
    return await STAGE_RUNNERS[stage](task, deps);
  } catch (error) {
    if (attempt + 1 < maxAttempts) throw error;
    const input = await loadInput(stage, task, deps);
    const reason = `dead-letter after ${attempt + 1} attempts: ${String(error)}`;
    if (!input) return { status: "skipped", reason };
    return quarantine(stage, input, reason, deps);
  }
}
