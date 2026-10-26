import type { ScrapedEvent } from "../../scrapers/base.js";
import type { ResolvedLocation } from "../geocoder.js";
import type { UpsertOutcome } from "../firestore.js";
import { temporalExclusionReason } from "../temporalFilter.js";
import { checkpointId, quarantineId, STAGE_INPUT, type CheckpointDoc, type PipelineStore, type Stage } from "./checkpoints.js";
import { resolvedLocationViolations, scrapedEventViolations } from "./contracts.js";
import { LeaseBusyError } from "./leases.js";

// A replay has fresh, immutable outputs, but every delivery of that replay
// shares those outputs. replayId is an operation identity, not a skip switch.
export interface StageTask {
  inputId: string;
  replayId?: string;
}

export function parseStageTask(value: unknown): StageTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task must be an object");
  const task = value as Record<string, unknown>;
  if (typeof task.inputId !== "string" || !/^[a-f0-9]{40}$/.test(task.inputId)) throw new Error("inputId must be a checkpoint id");
  if (task.replayId !== undefined && (typeof task.replayId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.replayId))) {
    throw new Error("replayId is invalid");
  }
  return { inputId: task.inputId, ...(task.replayId === undefined ? {} : { replayId: task.replayId as string }) };
}

export interface StageDeps {
  store: PipelineStore;
  enqueue(stage: Stage, task: StageTask): Promise<void>;
  geocode(event: ScrapedEvent): Promise<ResolvedLocation | null>;
  upsert(event: ScrapedEvent, geo: ResolvedLocation | null, addId: string): Promise<UpsertOutcome>;
  // Production supplies a Firestore lease; fixtures may execute inline.
  exclusive?<T>(key: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
}

export type StageResult =
  | { status: "done"; outputId: string; detail?: string }
  | { status: "quarantined"; reason: string }
  | { status: "skipped"; reason: string };

async function loadInput(stage: Stage, task: StageTask, deps: StageDeps): Promise<CheckpointDoc> {
  const input = await deps.store.get(STAGE_INPUT[stage], task.inputId);
  if (!input) throw new Error(`input ${task.inputId} not found`);
  return input;
}

async function quarantine(stage: Stage, input: CheckpointDoc, reason: string, deps: StageDeps): Promise<StageResult> {
  await deps.store.quarantine({ stage, inputId: input.id, source: input.source, runId: input.runId, reason });
  console.warn(`[${stage}] quarantined ${input.id} (${input.source}): ${reason}`);
  return { status: "quarantined", reason };
}

function handoff(stage: Stage, input: CheckpointDoc, task: StageTask, data: Record<string, unknown>, deps: StageDeps): CheckpointDoc {
  return {
    id: checkpointId(stage, input.id, undefined, task.replayId),
    source: input.source,
    runId: input.runId,
    createdAtMs: (deps.now ?? Date.now)(),
    data: { ...data, inputId: input.id },
  };
}

async function exclusive<T>(key: string, work: () => Promise<T>, deps: StageDeps): Promise<T> {
  return deps.exclusive ? deps.exclusive(key, work) : work();
}

export async function runGate(task: StageTask, deps: StageDeps): Promise<StageResult> {
  const input = await loadInput("gate", task, deps);
  // Only releaseQuarantine clears a hold. A normal replay cannot bypass it.
  if (input.held) return { status: "skipped", reason: "held by circuit breaker" };
  const outputId = checkpointId("gate", input.id, undefined, task.replayId);
  let output = await deps.store.get("accepted", outputId);
  if (!output) {
    const event = input.data.event;
    const violations = scrapedEventViolations(event);
    const temporal = violations.length ? null : temporalExclusionReason(event as ScrapedEvent);
    if (violations.length) return quarantine("gate", input, `contract: ${violations.join("; ")}`, deps);
    if (temporal) return quarantine("gate", input, temporal, deps);
    output = handoff("gate", input, task, { event }, deps);
    await deps.store.put("accepted", output);
  }
  // Always retry the handoff, including after put succeeded but enqueue failed.
  await deps.enqueue("geocode", { inputId: output.id, ...(task.replayId ? { replayId: task.replayId } : {}) });
  await deps.store.markReleased(quarantineId("gate", input.id));
  return { status: "done", outputId: output.id };
}

export async function runGeocode(task: StageTask, deps: StageDeps): Promise<StageResult> {
  const input = await loadInput("geocode", task, deps);
  const violations = scrapedEventViolations(input.data.event);
  if (violations.length) return quarantine("geocode", input, `contract: ${violations.join("; ")}`, deps);
  return exclusive("pipeline-geocode", async () => {
    const outputId = checkpointId("geocode", input.id, undefined, task.replayId);
    let output = await deps.store.get("pinned", outputId);
    if (!output) {
      const event = input.data.event as ScrapedEvent;
      const geo = await deps.geocode(event);
      const badPin = resolvedLocationViolations(geo);
      if (badPin.length) return quarantine("geocode", input, `contract: ${badPin.join("; ")}`, deps);
      output = handoff("geocode", input, task, { event, geo }, deps);
      await deps.store.put("pinned", output);
    }
    await deps.enqueue("write", { inputId: output.id, ...(task.replayId ? { replayId: task.replayId } : {}) });
    await deps.store.markReleased(quarantineId("geocode", input.id));
    return { status: "done", outputId: output.id, detail: output.data.geo ? "pinned" : "no exact location" };
  }, deps);
}

export async function runWrite(task: StageTask, deps: StageDeps): Promise<StageResult> {
  const input = await loadInput("write", task, deps);
  const violations = [
    ...scrapedEventViolations(input.data.event),
    ...resolvedLocationViolations(input.data.geo),
  ];
  if (violations.length) return quarantine("write", input, `contract: ${violations.join("; ")}`, deps);
  return exclusive("pipeline-write", async () => {
    const outputId = checkpointId("write", input.id, undefined, task.replayId);
    if (await deps.store.get("written", outputId)) {
      await deps.store.markReleased(quarantineId("write", input.id));
      return { status: "skipped", reason: "already written" };
    }
    const outcome = await deps.upsert(input.data.event as ScrapedEvent, input.data.geo as ResolvedLocation | null, outputId);
    await deps.store.put("written", {
      id: outputId,
      source: input.source,
      runId: input.runId,
      createdAtMs: (deps.now ?? Date.now)(),
      data: { inputId: input.id, outcome },
    });
    await deps.store.markReleased(quarantineId("write", input.id));
    return { status: "done", outputId, detail: outcome.kind };
  }, deps);
}

export const STAGE_RUNNERS: Record<Stage, (task: StageTask, deps: StageDeps) => Promise<StageResult>> = {
  gate: runGate, geocode: runGeocode, write: runWrite,
};

export async function runWithDeadLetter(
  stage: Stage, task: StageTask, attempt: number, maxAttempts: number, deps: StageDeps
): Promise<StageResult> {
  try {
    return await STAGE_RUNNERS[stage](task, deps);
  } catch (error) {
    // Contention is not a bad item; never quarantine another worker's input.
    if (error instanceof LeaseBusyError || attempt + 1 < maxAttempts) throw error;
    const input = await deps.store.get(STAGE_INPUT[stage], task.inputId);
    const reason = `dead-letter after ${attempt + 1} attempts: ${String(error)}`;
    await deps.store.quarantine({ stage, inputId: task.inputId, source: input?.source ?? "unknown", runId: input?.runId ?? "unknown", reason });
    return { status: "quarantined", reason };
  }
}
