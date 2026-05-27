// Unit tests for src/lib/db/schedule-writer.ts.
// ADR-030 Phase 1 dual-write — Aurora UPSERT path for report_schedules.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock @/lib/db ---------------------------------------------------------
const mockQuery = vi.fn();
const isAuroraEnabledMock = vi.fn(() => true);

vi.mock('@/lib/db', () => ({
  isAuroraEnabled: () => isAuroraEnabledMock(),
  getDb: async () => ({ query: mockQuery }),
}));

import {
  shadowWriteSchedule,
  fireAndForgetWriteSchedule,
  readScheduleFromAurora,
} from '@/lib/db/schedule-writer';
import { getDriftCounters, _resetForTests } from '@/lib/db/drift';
import type { ReportSchedule } from '@/lib/report-scheduler';

function makeSchedule(overrides: Partial<ReportSchedule> = {}): ReportSchedule {
  return {
    enabled: true,
    frequency: 'weekly',
    dayOfWeek: 1,
    dayOfMonth: 1,
    hour: 6,
    lang: 'ko',
    lastRunAt: null,
    nextRunAt: '2026-06-01T21:00:00.000Z',
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('schedule-writer', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    isAuroraEnabledMock.mockReturnValue(true);
    _resetForTests();
  });

  describe('shadowWriteSchedule', () => {
    it('no-ops silently when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      await shadowWriteSchedule(makeSchedule());
      expect(mockQuery).not.toHaveBeenCalled();
      expect(getDriftCounters()).toEqual([]);
    });

    it('issues an INSERT … ON CONFLICT DO UPDATE (upsert)', async () => {
      await shadowWriteSchedule(makeSchedule());
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO report_schedules/);
      expect(sql).toMatch(/ON CONFLICT/);
      expect(sql).toMatch(/DO UPDATE/);
    });

    it('uses "_global" as the user_sub sentinel (slice 2 — no per-user schedules yet)', async () => {
      await shadowWriteSchedule(makeSchedule());
      const [, params] = mockQuery.mock.calls[0];
      // Params: user_sub($1), schedule_type($2), enabled($3),
      //         last_run_at($4), next_run_at($5), config($6)
      expect(params[0]).toBe('_global');
    });

    it('maps frequency to schedule_type', async () => {
      await shadowWriteSchedule(makeSchedule({ frequency: 'biweekly' }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[1]).toBe('biweekly');
    });

    it('passes enabled through unchanged', async () => {
      await shadowWriteSchedule(makeSchedule({ enabled: false }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[2]).toBe(false);
    });

    it('writes null for last_run_at and next_run_at when undefined', async () => {
      await shadowWriteSchedule(makeSchedule({ lastRunAt: null, nextRunAt: null }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[3]).toBeNull();
      expect(params[4]).toBeNull();
    });

    it('parses lastRunAt and nextRunAt into Date objects when set', async () => {
      await shadowWriteSchedule(makeSchedule({
        lastRunAt: '2026-05-20T03:00:00.000Z',
        nextRunAt: '2026-06-01T21:00:00.000Z',
      }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[3]).toBeInstanceOf(Date);
      expect((params[3] as Date).toISOString()).toBe('2026-05-20T03:00:00.000Z');
      expect(params[4]).toBeInstanceOf(Date);
      expect((params[4] as Date).toISOString()).toBe('2026-06-01T21:00:00.000Z');
    });

    it('packs dayOfWeek, dayOfMonth, hour, lang, accountId into the JSONB config', async () => {
      await shadowWriteSchedule(makeSchedule({
        dayOfWeek: 5,
        dayOfMonth: 15,
        hour: 9,
        lang: 'en',
        accountId: '111111111111',
      }));
      const [, params] = mockQuery.mock.calls[0];
      const config = JSON.parse(params[5]);
      expect(config).toEqual({
        day_of_week: 5,
        day_of_month: 15,
        hour: 9,
        lang: 'en',
        account_id: '111111111111',
      });
    });

    it('increments drift writes counter on successful upsert', async () => {
      await shadowWriteSchedule(makeSchedule());
      const snap = getDriftCounters();
      expect(snap[0]).toMatchObject({
        source: 'report_schedules',
        writes: 1,
        failures: 0,
      });
    });

    it('increments drift failures and re-throws on UPSERT failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('serialization failure'));
      await expect(shadowWriteSchedule(makeSchedule())).rejects.toThrow('serialization failure');
      const snap = getDriftCounters();
      expect(snap[0]).toMatchObject({
        source: 'report_schedules',
        failures: 1,
      });
    });
  });

  describe('fireAndForgetWriteSchedule', () => {
    it('returns undefined synchronously', () => {
      const ret = fireAndForgetWriteSchedule(makeSchedule());
      expect(ret).toBeUndefined();
    });

    it('does NOT propagate rejection when Aurora upsert fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('boom'));
      expect(() => fireAndForgetWriteSchedule(makeSchedule())).not.toThrow();
      await new Promise((r) => setImmediate(r));
      const snap = getDriftCounters();
      expect(snap[0].failures).toBe(1);
    });
  });

  describe('readScheduleFromAurora (parity helper)', () => {
    it('returns null without querying when Aurora is not configured', async () => {
      isAuroraEnabledMock.mockReturnValue(false);
      const r = await readScheduleFromAurora();
      expect(r).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns null when no row exists for the _global sentinel', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const r = await readScheduleFromAurora();
      expect(r).toBeNull();
    });

    it('returns the latest row when present, with Date columns parsed', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          schedule_type: 'weekly',
          enabled: true,
          last_run_at: new Date('2026-05-20T03:00:00Z'),
          next_run_at: new Date('2026-06-01T21:00:00Z'),
          config: { day_of_week: 1, day_of_month: 1, hour: 6, lang: 'ko' },
          updated_at: new Date('2026-05-27T00:00:00Z'),
        }],
        rowCount: 1,
      });
      const r = await readScheduleFromAurora();
      expect(r).not.toBeNull();
      expect(r!.scheduleType).toBe('weekly');
      expect(r!.enabled).toBe(true);
      expect(r!.lastRunAt).toBe('2026-05-20T03:00:00.000Z');
      expect(r!.nextRunAt).toBe('2026-06-01T21:00:00.000Z');
      expect(r!.config).toMatchObject({ day_of_week: 1, hour: 6, lang: 'ko' });
    });
  });
});
