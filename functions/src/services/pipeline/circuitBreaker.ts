// Per-source circuit breaker. Sources break silently: a redesign or a blocked
// request usually means "0 events, no error". If a source lists far fewer
// items than it usually does, today's output is held in quarantine instead of
// written, and yesterday's events stay on the map until they end.
//
// "Listed" counts every item the source saw, including ones the extraction
// cache skipped, so a quiet day with nothing new does not trip the breaker.

export const HISTORY_RUNS = 7;
const MIN_HISTORY = 3;

export interface SourceHealth {
  tripped: boolean;
  reason?: string;
  usual?: number;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function evaluateSourceHealth(listed: number, history: number[]): SourceHealth {
  if (history.length < MIN_HISTORY) return { tripped: false };
  const usual = median(history);
  if (usual >= 5 && listed === 0) {
    return { tripped: true, usual, reason: `listed 0 items (usually ~${usual})` };
  }
  if (usual >= 10 && listed < usual * 0.25) {
    return { tripped: true, usual, reason: `listed ${listed} items (usually ~${usual})` };
  }
  return { tripped: false, usual };
}
