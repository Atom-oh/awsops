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

  // PR #195 round-3 review MAJOR: round-2's sub->identity() rekey has no bulk migration (no queryable
  // sub->email mapping table exists) — a legacy row keyed by the raw sub must be found and migrated
  // on the next GET by a user whose identity() (email) differs from their sub.
  it('self-heals: a legacy sub-keyed row is found and migrated when the identity()-keyed lookup is empty', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // no row yet under the email-keyed identity
      .mockResolvedValueOnce({ rowCount: 1 }) // rename UPDATE (legacy -> identity)
      .mockResolvedValueOnce({ rowCount: 0 }) // disable-leftover-legacy UPDATE (nothing left)
      .mockResolvedValueOnce({
        rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
      }); // re-select under identity finds the migrated row
    const s = await readSchedule('u1@x.io', 'u1');
    expect(s).toMatchObject({ scheduleType: 'weekly', enabled: true });
    const rename = queryMock.mock.calls[1];
    expect(rename[0]).toMatch(/UPDATE report_schedules r SET user_sub = \$1/);
    expect(rename[1]).toEqual(['u1@x.io', 'u1']);
    const disable = queryMock.mock.calls[2];
    expect(disable[0]).toMatch(/UPDATE report_schedules SET enabled = false WHERE user_sub = \$1/);
    expect(disable[1]).toEqual(['u1']);
  });

  it('does not attempt a legacy migration when identity() and sub are the same value', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await readSchedule('u1', 'u1')).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1); // no extra rename/disable queries
  });
});

describe('upsertSchedule', () => {
  it('upserts with a recomputed next_run_at and config, returns the mapped row', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
    });
    const s = await upsertSchedule('u1', { scheduleType: 'weekly', enabled: true, tier: 'mid', nowISO: '2026-06-18T00:00:00.000Z' });
    // disable-others UPDATE runs first (no cross-frequency double-fire)
    const disable = queryMock.mock.calls.find((c) => /UPDATE report_schedules SET enabled = false/.test(c[0] as string));
    expect(disable).toBeTruthy();
    expect(disable![1]).toEqual(['u1', 'weekly']);
    // then the upsert
    const insert = queryMock.mock.calls.find((c) => /INSERT INTO report_schedules/.test(c[0] as string))!;
    expect(insert[0]).toMatch(/ON CONFLICT \(user_sub, schedule_type\)/);
    const params = insert[1] as unknown[];
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('weekly');
    expect(params[2]).toBe(true);
    expect(params[3]).toBe('2026-06-25T00:00:00.000Z'); // recomputed next_run_at
    expect(JSON.parse(params[4] as string)).toEqual({ tier: 'mid', model: null });
    expect(s.scheduleType).toBe('weekly');
  });

  it('still sets next_run_at when disabled (NOT NULL column); enabled flag gates firing', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'monthly', enabled: false, next_run_at: '2026-07-18T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
    });
    await upsertSchedule('u1', { scheduleType: 'monthly', enabled: false, nowISO: '2026-06-18T00:00:00.000Z' });
    const insert = (queryMock.mock.calls.find((c) => /INSERT INTO report_schedules/.test(c[0] as string))!)[1] as unknown[];
    expect(insert[2]).toBe(false);
    expect(insert[3]).toBe('2026-07-18T00:00:00.000Z'); // next_run_at present even when disabled
  });

  it('disables other-frequency rows even when the target is the only one (idempotent)', async () => {
    queryMock.mockResolvedValue({ rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: {} }] });
    await upsertSchedule('u1', { scheduleType: 'weekly', enabled: true });
    expect(queryMock.mock.calls.some((c) => /UPDATE report_schedules SET enabled = false/.test(c[0] as string) && (c[1] as unknown[])[1] === 'weekly')).toBe(true);
  });

  // PR #195 round-3 review MAJOR: a legacy sub-keyed row must be migrated (or disabled if it can't move)
  // BEFORE the disable-other-frequencies step, so it can never survive un-migrated and double-fire
  // alongside a newly created identity()-keyed row (duplicate diagnosis runs / duplicate Bedrock cost).
  it('folds a legacy sub-keyed row into the identity-keyed one before upserting, when legacySub differs', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1 }) // rename UPDATE (legacy -> identity)
      .mockResolvedValueOnce({ rowCount: 0 }) // disable-leftover-legacy UPDATE
      .mockResolvedValueOnce({ rowCount: 0 }) // disable-other-frequencies UPDATE
      .mockResolvedValueOnce({
        rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
      }); // upsert
    await upsertSchedule('u1@x.io', { scheduleType: 'weekly', enabled: true, nowISO: '2026-06-18T00:00:00.000Z' }, 'u1');
    const rename = queryMock.mock.calls[0];
    expect(rename[0]).toMatch(/UPDATE report_schedules r SET user_sub = \$1/);
    expect(rename[1]).toEqual(['u1@x.io', 'u1']);
    const disableLegacy = queryMock.mock.calls[1];
    expect(disableLegacy[0]).toMatch(/UPDATE report_schedules SET enabled = false WHERE user_sub = \$1/);
    expect(disableLegacy[1]).toEqual(['u1']);
    // the migration runs before the disable-other-frequencies step, which is scoped to the identity key
    const disableOthers = queryMock.mock.calls[2];
    expect(disableOthers[0]).toMatch(/UPDATE report_schedules SET enabled = false WHERE user_sub = \$1 AND schedule_type/);
    expect(disableOthers[1]).toEqual(['u1@x.io', 'weekly']);
  });

  it('skips the legacy migration entirely when no legacySub is given or it matches the identity key', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 0 }) // disable-other-frequencies
      .mockResolvedValueOnce({
        rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: {} }],
      });
    await upsertSchedule('u1', { scheduleType: 'weekly', enabled: true });
    expect(queryMock).toHaveBeenCalledTimes(2); // disable-others + upsert only, no rename/disable-legacy
  });
});
