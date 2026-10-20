import { randomUUID } from "node:crypto";
import { STAGE_INPUT, STAGES, type PipelineStore, type Stage } from "./checkpoints.js";
import type { StageTask } from "./stages.js";

// Rerun one stage for a slice of its saved inputs: one source, a date range,
// or a single item. Stages hand off to the next as they finish, so replaying
// geocode also reruns dedup + write for those items, while extraction (and
// its LLM cost) is reused from the checkpoints. To pick up a logic change,
// bump the stage's version in checkpoints.ts first.
//
// releaseQuarantine instead re-queues items a stage quarantined, including
// items a source's circuit breaker held back.

export interface ReplayRequest {
  stage: Stage;
  source?: string;
  sinceMs?: number;
  untilMs?: number;
  inputId?: string;
  releaseQuarantine?: boolean;
}

export interface ReplayDeps {
  store: PipelineStore;
  enqueue(stage: Stage, task: StageTask): Promise<void>;
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function parseReplayRequest(raw: unknown): ReplayRequest {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (!STAGES.includes(body.stage as Stage)) {
    throw new Error(`stage must be one of ${STAGES.join(", ")}`);
  }
  const optionalString = (key: string) => (typeof body[key] === "string" && body[key] ? (body[key] as string) : undefined);
  const optionalTime = (key: string) => {
    if (body[key] === undefined) return undefined;
    const ms = typeof body[key] === "number" ? (body[key] as number) : Date.parse(String(body[key]));
    if (!Number.isFinite(ms)) throw new Error(`${key} is not a valid date`);
    return ms;
  };
  return {
    stage: body.stage as Stage,
    source: optionalString("source"),
    inputId: optionalString("inputId"),
    sinceMs: optionalTime("since"),
    untilMs: optionalTime("until"),
    releaseQuarantine: body.releaseQuarantine === true,
  };
}

export async function replay(request: ReplayRequest, deps: ReplayDeps): Promise<{ replayId: string; queued: number }> {
  const replayId = randomUUID();
  const now = (deps.now ?? Date.now)();
  const sinceMs = request.sinceMs ?? now - DEFAULT_WINDOW_MS;
  const untilMs = request.untilMs ?? now;
  const matchesSource = (source: string) => !request.source || source === request.source;
  let queued = 0;

  if (request.releaseQuarantine) {
    const entries = await deps.store.listQuarantine(request.stage, sinceMs);
    for (const entry of entries) {
      if (entry.released || !matchesSource(entry.source) || entry.createdAtMs > untilMs) continue;
      if (request.inputId && entry.inputId !== request.inputId) continue;
      if (request.stage === "gate") await deps.store.setHeld(entry.inputId, false);
      await deps.enqueue(request.stage, { inputId: entry.inputId, replayId });
      await deps.store.markReleased(entry.id);
      queued++;
    }
    return { replayId, queued };
  }

  if (request.inputId) {
    await deps.enqueue(request.stage, { inputId: request.inputId, replayId });
    return { replayId, queued: 1 };
  }

  const inputs = await deps.store.list(STAGE_INPUT[request.stage], sinceMs, untilMs);
  for (const input of inputs) {
    if (!matchesSource(input.source) || input.held) continue;
    await deps.enqueue(request.stage, { inputId: input.id, replayId });
    queued++;
  }
  return { replayId, queued };
}
