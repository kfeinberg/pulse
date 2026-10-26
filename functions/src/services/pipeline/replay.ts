import { randomUUID } from "node:crypto";
import { STAGE_INPUT, STAGES, type PipelineStore, type Stage } from "./checkpoints.js";
import type { StageTask } from "./stages.js";

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
const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_REPLAY_ITEMS = 1000;

export function parseReplayRequest(raw: unknown): ReplayRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("request must be an object");
  const body = raw as Record<string, unknown>;
  if (!STAGES.includes(body.stage as Stage)) throw new Error(`stage must be one of ${STAGES.join(", ")}`);
  const optionalString = (key: string, pattern: RegExp) => {
    if (body[key] === undefined) return undefined;
    if (typeof body[key] !== "string" || !pattern.test(body[key] as string)) throw new Error(`${key} is invalid`);
    return body[key] as string;
  };
  const optionalTime = (key: string) => {
    if (body[key] === undefined) return undefined;
    if (typeof body[key] !== "number" && typeof body[key] !== "string") throw new Error(`${key} is not a valid date`);
    const ms = typeof body[key] === "number" ? body[key] as number : Date.parse(body[key] as string);
    if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(new Date(ms).getTime())) throw new Error(`${key} is not a valid date`);
    return ms;
  };
  if (body.releaseQuarantine !== undefined && typeof body.releaseQuarantine !== "boolean") throw new Error("releaseQuarantine must be a boolean");
  const request = {
    stage: body.stage as Stage,
    source: optionalString("source", /^[a-zA-Z0-9_-]{1,80}$/),
    inputId: optionalString("inputId", /^[a-f0-9]{40}$/),
    sinceMs: optionalTime("since"),
    untilMs: optionalTime("until"),
    releaseQuarantine: body.releaseQuarantine === true,
  };
  if (request.sinceMs !== undefined && request.untilMs !== undefined && request.sinceMs > request.untilMs) throw new Error("since must not be after until");
  return request;
}

export async function replay(request: ReplayRequest, deps: ReplayDeps): Promise<{ replayId: string; queued: number }> {
  const replayId = randomUUID();
  const now = (deps.now ?? Date.now)();
  const untilMs = request.untilMs ?? now;
  const sinceMs = request.sinceMs ?? Math.max(0, untilMs - DEFAULT_WINDOW_MS);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs || untilMs - sinceMs > MAX_WINDOW_MS) {
    throw new Error("replay window must be ordered and at most 14 days");
  }
  const matches = (source: string, createdAtMs: number) =>
    (!request.source || source === request.source) && createdAtMs >= sinceMs && createdAtMs <= untilMs;
  let inputs: Array<{ id: string; quarantineId?: string }>;
  if (request.releaseQuarantine) {
    const single = request.inputId ? await deps.store.getQuarantine(request.stage, request.inputId) : null;
    const entries = request.inputId ? (single ? [single] : []) : await deps.store.listQuarantine(
      request.stage, sinceMs, MAX_REPLAY_ITEMS + 1, { untilMs, source: request.source }
    );
    if (entries.length > MAX_REPLAY_ITEMS) throw new Error("too many replay candidates; narrow the date range");
    inputs = [];
    for (const entry of entries) {
      if (entry.released || !matches(entry.source, entry.createdAtMs) || (request.inputId && entry.inputId !== request.inputId)) continue;
      // Cleanup or a malformed task may have left a quarantine entry whose
      // input no longer exists. Never report it as a successful release.
      const input = await deps.store.get(STAGE_INPUT[request.stage], entry.inputId);
      if (input && (!request.source || input.source === request.source)) inputs.push({ id: input.id, quarantineId: entry.id });
    }
  } else if (request.inputId) {
    const input = await deps.store.get(STAGE_INPUT[request.stage], request.inputId);
    inputs = input && !input.held && matches(input.source, input.createdAtMs) ? [{ id: input.id }] : [];
  } else {
    const candidates = await deps.store.list(STAGE_INPUT[request.stage], sinceMs, untilMs, MAX_REPLAY_ITEMS + 1, request.source);
    if (candidates.length > MAX_REPLAY_ITEMS) throw new Error("too many replay candidates; narrow the date range");
    inputs = candidates.filter((input) => !input.held && matches(input.source, input.createdAtMs)).map((input) => ({ id: input.id }));
  }
  let queued = 0;
  for (const input of inputs) {
    if (input.quarantineId && request.stage === "gate") await deps.store.setHeld(input.id, false);
    await deps.enqueue(request.stage, { inputId: input.id, replayId });
    // The worker marks a quarantine entry released only after successful work,
    // so fast execution/failure cannot race an enqueue-time release update.
    queued++;
  }
  return { replayId, queued };
}
