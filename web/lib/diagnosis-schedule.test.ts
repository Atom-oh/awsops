import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: queryMock }) }));

import { computeNextRun, readSchedule, upsertSchedule } from './diagnosis-schedule';

beforeEach(() => queryMock.mockReset());

describe('computeNextRun', () => {
  const from = '2026-06-18T00:00:00.000Z';
  it('weekly adds 7 days', () => expect(computeNextRun('weekly', from)).toBe('2026-06-25T00:00:00.000Z'));
  it('biweekly adds 14 days', () => expect(computeNextRun('biweekly', from)).toBe('2026-07-02T00:00:00.000Z'));
  it('monthly adds 1 calendar month', () => expect(computeNextRun('monthly', from)).toBe('2026-07-18T00:00:00.000Z'));
});

describe('readSchedule', () => {
  it('returns null when the user has no schedule', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await readSchedule('u1')).toBeNull();
    expect(queryMock.mock.calls[0][1]).toEqual(['u1']); // scoped by user_sub
  });

  it('maps a row (tier/model from config) when present', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: { tier: 'deep', model: 'opus' } }],
    });
    const s = await readSchedule('u1');
    expect(s).toMatchObject({ scheduleType: 'weekly', enabled: true, tier: 'deep', model: 'opus', nextRunAt: '2026-06-25T00:00:00.000Z', lastRunAt: null });
  });
});

describe('upsertSchedule', () => {
  it('upserts with a recomputed next_run_at and config, returns the mapped row', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
    });
    const s = await upsertSchedule('u1', { scheduleType: 'weekly', enabled: true, tier: 'mid', nowISO: '2026-06-18T00:00:00.000Z' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO report_schedules/);
    expect(sql).toMatch(/ON CONFLICT \(user_sub, schedule_type\)/);
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('weekly');
    expect(params[2]).toBe(true);
    expect(params[3]).toBe('2026-06-25T00:00:00.000Z'); // recomputed next_run_at
    expect(JSON.parse(params[4])).toEqual({ tier: 'mid', model: null });
    expect(s.scheduleType).toBe('weekly');
  });

  it('still sets next_run_at when disabled (NOT NULL column); enabled flag gates firing', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'monthly', enabled: false, next_run_at: '2026-07-18T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
    });
    await upsertSchedule('u1', { scheduleType: 'monthly', enabled: false, nowISO: '2026-06-18T00:00:00.000Z' });
    const params = queryMock.mock.calls[0][1];
    expect(params[2]).toBe(false);
    expect(params[3]).toBe('2026-07-18T00:00:00.000Z'); // next_run_at present even when disabled
  });
});
