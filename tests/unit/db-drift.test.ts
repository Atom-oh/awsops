// Unit tests for src/lib/db/drift.ts — drift accounting for ADR-030 dual-write.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordWrite,
  recordFailure,
  getDriftCounters,
  _resetForTests,
} from '@/lib/db/drift';

describe('db/drift', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('returns empty snapshot when no sources have been used', () => {
    expect(getDriftCounters()).toEqual([]);
  });

  it('counts writes and reports zero failure rate', () => {
    recordWrite('agentcore_stats');
    recordWrite('agentcore_stats');
    recordWrite('agentcore_stats');

    const snap = getDriftCounters();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      source: 'agentcore_stats',
      writes: 3,
      failures: 0,
      failureRate: 0,
      lastFailureAt: null,
      lastFailureMessage: null,
    });
  });

  it('counts failures and captures last-failure detail', () => {
    recordWrite('agentcore_stats');
    recordFailure('agentcore_stats', new Error('connect ECONNREFUSED'));

    const snap = getDriftCounters();
    expect(snap[0].writes).toBe(1);
    expect(snap[0].failures).toBe(1);
    expect(snap[0].failureRate).toBeCloseTo(0.5, 5);
    expect(snap[0].lastFailureMessage).toBe('connect ECONNREFUSED');
    expect(snap[0].lastFailureAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts non-Error failure values and stringifies them', () => {
    recordFailure('agentcore_stats', 'raw string error');
    const afterString = getDriftCounters()[0].lastFailureMessage;
    expect(afterString).toBe('raw string error');

    recordFailure('agentcore_stats', { code: 'ETIMEDOUT' });
    expect(getDriftCounters()[0].failures).toBe(2);
    // Plain object stringifies to '[object Object]'
    expect(getDriftCounters()[0].lastFailureMessage).toBe('[object Object]');
  });

  it('isolates counters across sources', () => {
    recordWrite('agentcore_stats');
    recordWrite('inventory_snapshots');
    recordFailure('inventory_snapshots', new Error('schema mismatch'));

    const snap = getDriftCounters();
    const byKey = Object.fromEntries(snap.map((s) => [s.source, s]));
    expect(byKey.agentcore_stats.failures).toBe(0);
    expect(byKey.inventory_snapshots.failures).toBe(1);
    expect(byKey.inventory_snapshots.lastFailureMessage).toBe('schema mismatch');
  });
});
