// Unit tests for src/lib/db/agentcore-stats-writer.ts.
// ADR-030 Phase 1 dual-write — Aurora INSERT path for agentcore_stats.
//
// The pg Pool is mocked through @/lib/db so these tests run offline without
// a real Aurora cluster. We assert: column mapping, payload shape, drift
// counter updates, and the no-op branch when Aurora is disabled.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock @/lib/db ---------------------------------------------------------
const mockQuery = vi.fn();
const isAuroraEnabledMock = vi.fn(() => true);

vi.mock('@/lib/db', () => ({
  isAuroraEnabled: () => isAuroraEnabledMock(),
  getDb: async () => ({ query: mockQuery }),
}));

import {
  recordCallToAurora,
  countAuroraCalls,
  fireAndForgetCallToAurora,
} from '@/lib/db/agentcore-stats-writer';
import { getDriftCounters, _resetForTests } from '@/lib/db/drift';
import type { AgentCoreCallRecord } from '@/lib/agentcore-stats';

function makeRecord(overrides: Partial<AgentCoreCallRecord> = {}): AgentCoreCallRecord {
  return {
    timestamp: '2026-05-27T10:00:00.000Z',
    route: 'code',
    gateway: 'code-interpreter',
    responseTimeMs: 1234,
    usedTools: ['python', 'matplotlib'],
    success: true,
    via: 'bedrock-opus',
    inputTokens: 100,
    outputTokens: 200,
    model: 'claude-opus-4-8',
    ...overrides,
  };
}

describe('agentcore-stats-writer', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    isAuroraEnabledMock.mockReturnValue(true);
    _resetForTests();
  });

  describe('recordCallToAurora', () => {
    it('no-ops silently when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      await recordCallToAurora(makeRecord());
      expect(mockQuery).not.toHaveBeenCalled();
      expect(getDriftCounters()).toEqual([]);
    });

    it('issues a single INSERT into agentcore_stats on success', async () => {
      await recordCallToAurora(makeRecord());
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO agentcore_stats/);
    });

    it('maps record.route to the event_type column', async () => {
      await recordCallToAurora(makeRecord({ route: 'network' }));
      const [, params] = mockQuery.mock.calls[0];
      // SQL columns: occurred_at($1), event_type($2), gateway($3), model($4),
      // duration_ms($5), input_tokens($6), output_tokens($7), payload($8)
      expect(params[1]).toBe('network');
    });

    it('uses "unknown" for event_type when route is empty', async () => {
      await recordCallToAurora(makeRecord({ route: '' }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[1]).toBe('unknown');
    });

    it('puts used_tools, success, and via in the JSONB payload', async () => {
      await recordCallToAurora(makeRecord({
        usedTools: ['x', 'y'],
        success: false,
        via: 'fallback',
      }));
      const [, params] = mockQuery.mock.calls[0];
      const payload = JSON.parse(params[7]);
      expect(payload).toEqual({
        used_tools: ['x', 'y'],
        success: false,
        via: 'fallback',
      });
    });

    it('parses record.timestamp into occurred_at when provided', async () => {
      await recordCallToAurora(makeRecord({ timestamp: '2026-05-27T10:00:00.000Z' }));
      const [, params] = mockQuery.mock.calls[0];
      const occurredAt = params[0] as Date;
      expect(occurredAt).toBeInstanceOf(Date);
      expect(occurredAt.toISOString()).toBe('2026-05-27T10:00:00.000Z');
    });

    it('falls back to current time when record.timestamp is missing', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = makeRecord({ timestamp: undefined as any });
      const before = Date.now();
      await recordCallToAurora(r);
      const after = Date.now();
      const occurredAt = mockQuery.mock.calls[0][1][0] as Date;
      expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(occurredAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('increments drift writes counter on successful insert', async () => {
      await recordCallToAurora(makeRecord());
      const snap = getDriftCounters();
      expect(snap).toHaveLength(1);
      expect(snap[0]).toMatchObject({
        source: 'agentcore_stats',
        writes: 1,
        failures: 0,
      });
    });

    it('increments drift failures and re-throws on INSERT failure', async () => {
      const dbError = new Error('connection terminated');
      mockQuery.mockRejectedValueOnce(dbError);

      await expect(recordCallToAurora(makeRecord())).rejects.toThrow('connection terminated');

      const snap = getDriftCounters();
      expect(snap[0]).toMatchObject({
        source: 'agentcore_stats',
        writes: 0,
        failures: 1,
      });
      expect(snap[0].lastFailureMessage).toBe('connection terminated');
    });
  });

  describe('fireAndForgetCallToAurora', () => {
    it('returns synchronously (does not await the underlying INSERT)', () => {
      // If this awaited, the return would be a settled Promise. We assert
      // void by checking the return value is undefined (not a Promise).
      const ret = fireAndForgetCallToAurora(makeRecord());
      expect(ret).toBeUndefined();
    });

    it('still fires the underlying recordCallToAurora call', async () => {
      fireAndForgetCallToAurora(makeRecord());
      // Allow the microtask queue to flush the floating promise.
      await new Promise((r) => setImmediate(r));
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('does NOT propagate rejection when the underlying INSERT fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('boom'));
      expect(() => fireAndForgetCallToAurora(makeRecord())).not.toThrow();
      // Drift accounting still happens.
      await new Promise((r) => setImmediate(r));
      const snap = getDriftCounters();
      expect(snap[0].failures).toBe(1);
    });
  });

  describe('countAuroraCalls', () => {
    it('returns 0 without querying when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      const n = await countAuroraCalls(new Date(0), new Date());
      expect(n).toBe(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns the row count from a windowed SELECT', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ c: '42' }], rowCount: 1 });
      const since = new Date('2026-05-27T00:00:00Z');
      const until = new Date('2026-05-27T12:00:00Z');

      const n = await countAuroraCalls(since, until);

      expect(n).toBe(42);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/SELECT COUNT\(\*\).*FROM agentcore_stats/);
      expect(params).toEqual([since, until]);
    });
  });
});
