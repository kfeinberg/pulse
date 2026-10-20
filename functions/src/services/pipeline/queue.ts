import { createHash } from "node:crypto";
import { getFunctions } from "firebase-admin/functions";
import type { Stage } from "./checkpoints.js";
import type { StageTask } from "./stages.js";

// One Cloud Tasks queue per stage, each with its own retry and concurrency
// policy. Geocoding is held to Nominatim's 1 request/second; writes run one at
// a time so two copies of the same new event cannot both miss each other in
// dedup.
export const STAGE_QUEUES = {
  gate: {
    functionName: "pipelineGate",
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 600 },
    rateLimits: { maxConcurrentDispatches: 10 },
    timeoutSeconds: 60,
  },
  geocode: {
    functionName: "pipelineGeocode",
    retryConfig: { maxAttempts: 6, minBackoffSeconds: 60, maxBackoffSeconds: 1800 },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    timeoutSeconds: 300,
  },
  write: {
    functionName: "pipelineWrite",
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 60, maxBackoffSeconds: 1200 },
    rateLimits: { maxConcurrentDispatches: 1 },
    timeoutSeconds: 300,
  },
} as const satisfies Record<Stage, unknown>;

// Task ids make enqueueing idempotent: the same stage/input pair is accepted
// once (Cloud Tasks rejects duplicates for about an hour), while a replay's
// id differs. Hash first, as Cloud Tasks recommends evenly distributed ids.
export function taskId(stage: Stage, task: StageTask): string {
  const key = `${stage}|${task.inputId}|${task.replayId ?? ""}`;
  return `${createHash("sha256").update(key).digest("hex").slice(0, 32)}-${stage}`;
}

export function cloudTasksEnqueuer(): (stage: Stage, task: StageTask) => Promise<void> {
  return async (stage, task) => {
    try {
      await getFunctions().taskQueue(STAGE_QUEUES[stage].functionName).enqueue(task, { id: taskId(stage, task) });
    } catch (error) {
      if ((error as { code?: string }).code === "functions/task-already-exists") return;
      throw error;
    }
  };
}
