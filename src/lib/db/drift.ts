// ADR-030 Phase 1 dual-write — drift accounting.
//
// During Phase 1 the JSON file remains the source of truth (reads). Aurora
// writes are fire-and-forget so a failure cannot break a user-facing request,
// but failures MUST be visible so the 7-day parity gate (ADR-030) reflects
// reality, not silently-dropped writes.
//
// Each source registers itself with a string key (e.g. `agentcore_stats`).
// `recordWrite()` is called on success, `recordFailure()` is called on error.
// `getDriftCounters()` returns the per-source totals + last-failure detail
// for the parity endpoint.

interface DriftCounter {
  writes: number;
  failures: number;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
}

const counters: Map<string, DriftCounter> = new Map();

function get(key: string): DriftCounter {
  let c = counters.get(key);
  if (!c) {
    c = { writes: 0, failures: 0, lastFailureAt: null, lastFailureMessage: null };
    counters.set(key, c);
  }
  return c;
}

export function recordWrite(source: string): void {
  get(source).writes++;
}

export function recordFailure(source: string, err: unknown): void {
  const c = get(source);
  c.failures++;
  c.lastFailureAt = new Date().toISOString();
  c.lastFailureMessage = err instanceof Error ? err.message : String(err);
}

export interface DriftSnapshot {
  source: string;
  writes: number;
  failures: number;
  failureRate: number;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
}

export function getDriftCounters(): DriftSnapshot[] {
  return Array.from(counters.entries()).map(([source, c]) => ({
    source,
    writes: c.writes,
    failures: c.failures,
    failureRate: c.writes + c.failures === 0 ? 0 : c.failures / (c.writes + c.failures),
    lastFailureAt: c.lastFailureAt,
    lastFailureMessage: c.lastFailureMessage,
  }));
}

// Test-only. Production code never resets in-process counters.
export function _resetForTests(): void {
  counters.clear();
}
