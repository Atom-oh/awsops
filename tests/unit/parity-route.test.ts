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
const listEventsMock = vi.fn();
const readEventsFromAuroraMock = vi.fn();
const countAuroraEventsMock = vi.fn();

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
vi.mock('@/lib/event-scaling', () => ({
  listEvents: (...args: unknown[]) => listEventsMock(...args),
}));
vi.mock('@/lib/db/event-scaling-writer', () => ({
  readEventsFromAurora: () => readEventsFromAuroraMock(),
  countAuroraEvents: () => countAuroraEventsMock(),
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
    listEventsMock.mockReset();
    readEventsFromAuroraMock.mockReset();
    countAuroraEventsMock.mockReset();
    listEventsMock.mockReturnValue([]);
    readEventsFromAuroraMock.mockResolvedValue([]);
    countAuroraEventsMock.mockResolvedValue(0);

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
    const statsParity = body.parity.find((p: { source: string }) => p.source === 'agentcore_stats');
    expect(statsParity.jsonRecentCalls).toBe(2);
    expect(statsParity.auroraCount).toBe(7);
    expect(statsParity.drift).toBe(5);
  });

  describe('event_scaling_plans parity', () => {
    it('includes an event_scaling_plans entry in the default parity array', async () => {
      const res = await GET(makeReq());
      const body = await res.json();
      const sources = body.parity.map((p: { source: string }) => p.source);
      expect(sources).toContain('event_scaling_plans');
    });

    it('reports inSync:true when JSON and Aurora counts match', async () => {
      listEventsMock.mockReturnValue([
        { eventId: 'a' }, { eventId: 'b' }, { eventId: 'c' },
      ]);
      countAuroraEventsMock.mockResolvedValue(3);

      const res = await GET(makeReq());
      const body = await res.json();
      const ev = body.parity.find((p: { source: string }) => p.source === 'event_scaling_plans');
      expect(ev.inSync).toBe(true);
      expect(ev.jsonCount).toBe(3);
      expect(ev.auroraCount).toBe(3);
      expect(ev.drift).toBe(0);
    });

    it('reports inSync:false and a non-zero drift when counts differ', async () => {
      listEventsMock.mockReturnValue([{ eventId: 'a' }, { eventId: 'b' }]);
      countAuroraEventsMock.mockResolvedValue(5);

      const res = await GET(makeReq());
      const body = await res.json();
      const ev = body.parity.find((p: { source: string }) => p.source === 'event_scaling_plans');
      expect(ev.inSync).toBe(false);
      expect(ev.jsonCount).toBe(2);
      expect(ev.auroraCount).toBe(5);
      expect(ev.drift).toBe(3);
    });

    it('?source=event_scaling_plans filters parity and drift to that source only', async () => {
      getDriftCountersMock.mockReturnValue([
        { source: 'agentcore_stats', writes: 5, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
        { source: 'event_scaling_plans', writes: 2, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
      ]);
      const res = await GET(makeReq('http://x/api/parity?source=event_scaling_plans'));
      const body = await res.json();
      expect(body.parity).toHaveLength(1);
      expect(body.parity[0].source).toBe('event_scaling_plans');
      expect(body.drift).toHaveLength(1);
      expect(body.drift[0].source).toBe('event_scaling_plans');
    });
  });
});
