// Unit tests for src/lib/db/event-scaling-writer.ts.
// ADR-030 Phase 1 dual-write — Aurora UPSERT + DELETE for event_scaling_plans.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock @/lib/db ---------------------------------------------------------
const mockQuery = vi.fn();
const isAuroraEnabledMock = vi.fn(() => true);

vi.mock('@/lib/db', () => ({
  isAuroraEnabled: () => isAuroraEnabledMock(),
  getDb: async () => ({ query: mockQuery }),
}));

import {
  shadowUpsertEvent,
  shadowDeleteEvent,
  fireAndForgetUpsertEvent,
  fireAndForgetDeleteEvent,
  readEventsFromAurora,
  countAuroraEvents,
} from '@/lib/db/event-scaling-writer';
import { getDriftCounters, _resetForTests } from '@/lib/db/drift';
import type { ScalingEvent } from '@/lib/event-scaling';

function makeEvent(overrides: Partial<ScalingEvent> = {}): ScalingEvent {
  return {
    eventId: '11111111-2222-3333-4444-555555555555',
    name: 'Black Friday 2026',
    description: 'Annual sales spike',
    eventStart: '2026-11-27T13:00:00.000Z',
    eventEnd: '2026-11-27T23:00:00.000Z',
    status: 'planned',
    pattern: {
      type: 'flash-sale',
      expectedPeakMultiplier: 10,
      durationMinutes: 120,
      rampUpMinutes: 60,
    },
    referenceEvents: [],
    accountId: '111111111111',
    createdBy: 'alice@example.com',
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('event-scaling-writer', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    isAuroraEnabledMock.mockReturnValue(true);
    _resetForTests();
  });

  describe('shadowUpsertEvent', () => {
    it('no-ops silently when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      await shadowUpsertEvent(makeEvent());
      expect(mockQuery).not.toHaveBeenCalled();
      expect(getDriftCounters()).toEqual([]);
    });

    it('issues a single INSERT … ON CONFLICT DO UPDATE on plan_id', async () => {
      await shadowUpsertEvent(makeEvent());
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO event_scaling_plans/i);
      expect(sql).toMatch(/ON CONFLICT\s*\(\s*plan_id\s*\)/i);
      expect(sql).toMatch(/DO UPDATE/i);
    });

    it('maps eventId→plan_id, name→event_name', async () => {
      await shadowUpsertEvent(makeEvent({
        eventId: 'evt-123',
        name: 'Q4 Earnings Call',
      }));
      const [, params] = mockQuery.mock.calls[0];
      // Params: plan_id($1), event_name($2), event_start_at($3), event_end_at($4),
      //         status($5), owner_email($6), payload($7)
      expect(params[0]).toBe('evt-123');
      expect(params[1]).toBe('Q4 Earnings Call');
    });

    it('parses eventStart/eventEnd into Date objects', async () => {
      await shadowUpsertEvent(makeEvent({
        eventStart: '2026-11-27T13:00:00.000Z',
        eventEnd: '2026-11-27T23:00:00.000Z',
      }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[2]).toBeInstanceOf(Date);
      expect((params[2] as Date).toISOString()).toBe('2026-11-27T13:00:00.000Z');
      expect(params[3]).toBeInstanceOf(Date);
      expect((params[3] as Date).toISOString()).toBe('2026-11-27T23:00:00.000Z');
    });

    it('passes status through unchanged so the CHECK constraint catches drift early', async () => {
      await shadowUpsertEvent(makeEvent({ status: 'analyzing' }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[4]).toBe('analyzing');
    });

    it('maps createdBy → owner_email; null when missing', async () => {
      await shadowUpsertEvent(makeEvent({ createdBy: 'bob@example.com' }));
      let [, params] = mockQuery.mock.calls[0];
      expect(params[5]).toBe('bob@example.com');

      mockQuery.mockClear();
      await shadowUpsertEvent(makeEvent({ createdBy: undefined }));
      [, params] = mockQuery.mock.calls[0];
      expect(params[5]).toBeNull();
    });

    it('serializes the full event into the JSONB payload', async () => {
      const event = makeEvent({ description: 'detail-text' });
      await shadowUpsertEvent(event);
      const [, params] = mockQuery.mock.calls[0];
      const payload = JSON.parse(params[6]);
      expect(payload.eventId).toBe(event.eventId);
      expect(payload.description).toBe('detail-text');
      expect(payload.pattern).toEqual(event.pattern);
    });

    it('increments drift writes counter on successful upsert', async () => {
      await shadowUpsertEvent(makeEvent());
      const snap = getDriftCounters();
      expect(snap[0]).toMatchObject({ source: 'event_scaling_plans', writes: 1, failures: 0 });
    });

    it('increments drift failures and re-throws on UPSERT failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('unique violation'));
      await expect(shadowUpsertEvent(makeEvent())).rejects.toThrow('unique violation');
      const snap = getDriftCounters();
      expect(snap[0]).toMatchObject({ source: 'event_scaling_plans', failures: 1 });
    });
  });

  describe('shadowDeleteEvent', () => {
    it('no-ops silently when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      await shadowDeleteEvent('evt-x');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('issues DELETE WHERE plan_id = $1', async () => {
      await shadowDeleteEvent('evt-abc');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/DELETE FROM event_scaling_plans/i);
      expect(sql).toMatch(/WHERE plan_id\s*=\s*\$1/i);
      expect(params[0]).toBe('evt-abc');
    });

    it('increments drift writes on successful DELETE', async () => {
      await shadowDeleteEvent('evt-abc');
      const snap = getDriftCounters();
      expect(snap[0]).toMatchObject({ source: 'event_scaling_plans', writes: 1, failures: 0 });
    });

    it('increments drift failures and re-throws on DELETE failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'));
      await expect(shadowDeleteEvent('evt-abc')).rejects.toThrow('connection lost');
      const snap = getDriftCounters();
      expect(snap[0].failures).toBe(1);
    });
  });

  describe('fire-and-forget wrappers', () => {
    it('fireAndForgetUpsertEvent returns undefined synchronously', () => {
      expect(fireAndForgetUpsertEvent(makeEvent())).toBeUndefined();
    });

    it('fireAndForgetUpsertEvent does NOT propagate rejection', async () => {
      mockQuery.mockRejectedValueOnce(new Error('boom'));
      expect(() => fireAndForgetUpsertEvent(makeEvent())).not.toThrow();
      await new Promise((r) => setImmediate(r));
      const snap = getDriftCounters();
      expect(snap[0].failures).toBe(1);
    });

    it('fireAndForgetDeleteEvent returns undefined synchronously', () => {
      expect(fireAndForgetDeleteEvent('evt-x')).toBeUndefined();
    });

    it('fireAndForgetDeleteEvent does NOT propagate rejection', async () => {
      mockQuery.mockRejectedValueOnce(new Error('boom'));
      expect(() => fireAndForgetDeleteEvent('evt-x')).not.toThrow();
      await new Promise((r) => setImmediate(r));
      const snap = getDriftCounters();
      expect(snap[0].failures).toBe(1);
    });
  });

  describe('parity helpers', () => {
    it('readEventsFromAurora returns [] when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      const r = await readEventsFromAurora();
      expect(r).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('readEventsFromAurora returns row payloads ordered by event_start_at DESC', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { plan_id: 'b', event_name: 'B', event_start_at: new Date('2026-12-01'), status: 'planned', updated_at: new Date(), payload: { eventId: 'b' } },
          { plan_id: 'a', event_name: 'A', event_start_at: new Date('2026-11-01'), status: 'planned', updated_at: new Date(), payload: { eventId: 'a' } },
        ],
        rowCount: 2,
      });
      const r = await readEventsFromAurora();
      expect(r).toHaveLength(2);
      expect(r[0].planId).toBe('b');
      expect(r[1].planId).toBe('a');
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/ORDER BY event_start_at DESC/i);
    });

    it('countAuroraEvents returns 0 when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      const n = await countAuroraEvents();
      expect(n).toBe(0);
    });

    it('countAuroraEvents returns the row count', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ c: '7' }], rowCount: 1 });
      const n = await countAuroraEvents();
      expect(n).toBe(7);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/SELECT COUNT\(\*\).*FROM event_scaling_plans/i);
    });
  });
});
