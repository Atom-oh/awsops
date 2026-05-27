// Unit tests for src/app/api/parity/route.ts.
// ADR-030 Phase 1 dual-write parity endpoint.
//
// All external dependencies (auth, app-config, db, writers, stats reader) are
// mocked so the route can be exercised offline with deterministic inputs.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---- Mocks (must come BEFORE the route import) ----------------------------
const getUserFromRequestMock = vi.fn();
const getConfigMock = vi.fn();
const isAuroraEnabledMock = vi.fn();
const checkDbHealthMock = vi.fn();
const getDriftCountersMock = vi.fn();
const countAuroraCallsMock = vi.fn();
const getStatsMock = vi.fn();
const readScheduleMock = vi.fn();
const readScheduleFromAuroraMock = vi.fn();

vi.mock('@/lib/auth-utils', () => ({
  getUserFromRequest: (...args: unknown[]) => getUserFromRequestMock(...args),
}));
vi.mock('@/lib/app-config', () => ({
  getConfig: () => getConfigMock(),
}));
vi.mock('@/lib/db', () => ({
  isAuroraEnabled: () => isAuroraEnabledMock(),
  checkDbHealth: () => checkDbHealthMock(),
}));
vi.mock('@/lib/db/drift', () => ({
  getDriftCounters: () => getDriftCountersMock(),
}));
vi.mock('@/lib/db/agentcore-stats-writer', () => ({
  countAuroraCalls: (...args: unknown[]) => countAuroraCallsMock(...args),
}));
vi.mock('@/lib/agentcore-stats', () => ({
  getStats: () => getStatsMock(),
}));
vi.mock('@/lib/report-scheduler', () => ({
  readSchedule: () => readScheduleMock(),
}));
vi.mock('@/lib/db/schedule-writer', () => ({
  readScheduleFromAurora: () => readScheduleFromAuroraMock(),
}));

import { GET } from '@/app/api/parity/route';

function makeReq(url = 'http://x/api/parity'): NextRequest {
  return new NextRequest(new URL(url));
}

function adminUser() {
  return { email: 'admin@example.com', sub: 'admin', groups: [] };
}

function configWithAdmin() {
  return { adminEmails: ['admin@example.com'] };
}

function configFreshInstall() {
  return { adminEmails: [] };
}

describe('parity route — GET /api/parity', () => {
  beforeEach(() => {
    getUserFromRequestMock.mockReset();
    getConfigMock.mockReset();
    isAuroraEnabledMock.mockReset();
    checkDbHealthMock.mockReset();
    getDriftCountersMock.mockReset();
    countAuroraCallsMock.mockReset();
    getStatsMock.mockReset();
    readScheduleMock.mockReset();
    readScheduleFromAuroraMock.mockReset();

    readScheduleMock.mockReturnValue({
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
    });
    readScheduleFromAuroraMock.mockResolvedValue({
      scheduleType: 'weekly',
      enabled: true,
      lastRunAt: null,
      nextRunAt: '2026-06-01T21:00:00.000Z',
      config: { day_of_week: 1, day_of_month: 1, hour: 6, lang: 'ko', account_id: null },
      updatedAt: '2026-05-27T00:00:00.000Z',
    });

    // Sensible defaults — individual tests override.
    getUserFromRequestMock.mockReturnValue(adminUser());
    getConfigMock.mockReturnValue(configWithAdmin());
    isAuroraEnabledMock.mockReturnValue(true);
    checkDbHealthMock.mockResolvedValue({ ok: true, schemaVersion: 1 });
    getDriftCountersMock.mockReturnValue([]);
    countAuroraCallsMock.mockResolvedValue(0);
    getStatsMock.mockReturnValue({
      recentCalls: [],
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      avgResponseTimeMs: 0,
      totalToolsUsed: 0,
      uniqueToolsUsed: [],
      callsByGateway: {},
      callsByRoute: {},
      lastUpdated: new Date().toISOString(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensByModel: {},
    });
  });

  it('returns 403 when caller is not an admin', async () => {
    getUserFromRequestMock.mockReturnValue({ email: 'bob@example.com', sub: 'bob', groups: [] });
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/admin/i);
  });

  it('treats fresh installs (empty adminEmails) as admin', async () => {
    getUserFromRequestMock.mockReturnValue({ email: 'anonymous', sub: 'x', groups: [] });
    getConfigMock.mockReturnValue(configFreshInstall());
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it('returns auroraEnabled:false with a guidance message when Aurora is not configured', async () => {
    isAuroraEnabledMock.mockReturnValue(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auroraEnabled).toBe(false);
    expect(body.message).toMatch(/AURORA_DATABASE_URL|AURORA_HOST/);
  });

  it('returns health, drift, and parity arrays when Aurora is enabled', async () => {
    getDriftCountersMock.mockReturnValue([
      { source: 'agentcore_stats', writes: 5, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
    ]);
    countAuroraCallsMock.mockResolvedValue(5);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.auroraEnabled).toBe(true);
    expect(body.health).toEqual({ ok: true, schemaVersion: 1 });
    expect(Array.isArray(body.drift)).toBe(true);
    expect(Array.isArray(body.parity)).toBe(true);
    expect(body.parity[0].source).toBe('agentcore_stats');
  });

  it('clamps the hours param into [1, 168]', async () => {
    await GET(makeReq('http://x/api/parity?hours=9999'));
    let [since, until] = countAuroraCallsMock.mock.calls.at(-1)!;
    let diff = (until.getTime() - since.getTime()) / 3_600_000;
    expect(diff).toBe(168);

    await GET(makeReq('http://x/api/parity?hours=0'));
    [since, until] = countAuroraCallsMock.mock.calls.at(-1)!;
    diff = (until.getTime() - since.getTime()) / 3_600_000;
    expect(diff).toBe(1);
  });

  it('?source=agentcore_stats filters the drift array to that source only', async () => {
    getDriftCountersMock.mockReturnValue([
      { source: 'agentcore_stats', writes: 5, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
      { source: 'inventory_snapshots', writes: 2, failures: 1, failureRate: 1 / 3, lastFailureAt: 't', lastFailureMessage: 'm' },
    ]);

    const res = await GET(makeReq('http://x/api/parity?source=agentcore_stats'));
    const body = await res.json();
    expect(body.drift).toHaveLength(1);
    expect(body.drift[0].source).toBe('agentcore_stats');
  });

  describe('report_schedules parity', () => {
    it('includes a report_schedules entry in the default parity array', async () => {
      const res = await GET(makeReq());
      const body = await res.json();
      const sources = body.parity.map((p: { source: string }) => p.source);
      expect(sources).toContain('report_schedules');
    });

    it('reports inSync:true when JSON and Aurora rows match on frequency + enabled + nextRunAt', async () => {
      const res = await GET(makeReq());
      const body = await res.json();
      const sched = body.parity.find((p: { source: string }) => p.source === 'report_schedules');
      expect(sched.inSync).toBe(true);
    });

    it('reports inSync:false when frequency differs between JSON and Aurora', async () => {
      readScheduleMock.mockReturnValue({
        ...readScheduleMock.getMockImplementation()!.call(null),
        frequency: 'monthly',
      });
      const res = await GET(makeReq());
      const body = await res.json();
      const sched = body.parity.find((p: { source: string }) => p.source === 'report_schedules');
      expect(sched.inSync).toBe(false);
      expect(sched.mismatchedFields).toContain('frequency');
    });

    it('reports auroraRow:null when no Aurora row exists yet', async () => {
      readScheduleFromAuroraMock.mockResolvedValue(null);
      const res = await GET(makeReq());
      const body = await res.json();
      const sched = body.parity.find((p: { source: string }) => p.source === 'report_schedules');
      expect(sched.auroraRow).toBeNull();
      expect(sched.inSync).toBe(false);
    });

    it('?source=report_schedules filters parity and drift to that source only', async () => {
      getDriftCountersMock.mockReturnValue([
        { source: 'agentcore_stats', writes: 5, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
        { source: 'report_schedules', writes: 2, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
      ]);
      const res = await GET(makeReq('http://x/api/parity?source=report_schedules'));
      const body = await res.json();
      expect(body.parity).toHaveLength(1);
      expect(body.parity[0].source).toBe('report_schedules');
      expect(body.drift).toHaveLength(1);
      expect(body.drift[0].source).toBe('report_schedules');
    });
  });

  it('computes |auroraCount - jsonRecentCalls| as the parity drift number', async () => {
    countAuroraCallsMock.mockResolvedValue(7);
    const now = Date.now();
    getStatsMock.mockReturnValue({
      recentCalls: [
        { timestamp: new Date(now - 30 * 60_000).toISOString() },  // 30 min ago
        { timestamp: new Date(now - 5 * 60_000).toISOString() },   // 5 min ago
        { timestamp: new Date(now - 25 * 3_600_000).toISOString() }, // 25h ago — outside default 24h window
      ],
      // unused fields stubbed
      totalCalls: 0, successCalls: 0, failedCalls: 0, avgResponseTimeMs: 0,
      totalToolsUsed: 0, uniqueToolsUsed: [], callsByGateway: {}, callsByRoute: {},
      lastUpdated: new Date().toISOString(),
      totalInputTokens: 0, totalOutputTokens: 0, tokensByModel: {},
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.parity[0].jsonRecentCalls).toBe(2);
    expect(body.parity[0].auroraCount).toBe(7);
    expect(body.parity[0].drift).toBe(5);
  });
});
