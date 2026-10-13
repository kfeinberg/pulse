export const TEMPORAL_STATUSES = [
  "scheduled_event",
  "limited_run",
  "permanent_attraction",
] as const;

export type TemporalStatus = (typeof TEMPORAL_STATUSES)[number];

export interface TemporalCandidate {
  title?: unknown;
  temporalStatus?: unknown;
  temporalEvidence?: unknown;
}

export function temporalExclusionReason(
  event: TemporalCandidate
): string | null {
  const title = typeof event.title === "string" ? event.title : "Untitled event";

  if (!TEMPORAL_STATUSES.includes(event.temporalStatus as TemporalStatus)) {
    return `missing or invalid temporalStatus for "${title}"`;
  }

  if (event.temporalStatus === "permanent_attraction") {
    return `permanent attraction: "${title}"`;
  }

  if (
    typeof event.temporalEvidence !== "string" ||
    event.temporalEvidence.trim().length === 0
  ) {
    return `missing temporal evidence for "${title}"`;
  }

  return null;
}

export function isTemporalEvent(event: TemporalCandidate): boolean {
  return temporalExclusionReason(event) === null;
}
