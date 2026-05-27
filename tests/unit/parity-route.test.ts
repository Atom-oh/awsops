// Unit tests for src/app/api/parity/route.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
const countAuroraDiagnosesMock = vi.fn();
const countJsonDiagnosesMock = vi.fn();
const getConversationsMock = vi.fn();
const countAuroraMemoryMock = vi.fn();
const countJsonInventoryDaysMock = vi.fn();
const countAuroraInventoryRowsMock = vi.fn();

vi.mock('@/lib/auth-utils', () => ({ getUserFromRequest: (...args: unknown[]) => getUserFromRequestMock(...args) }));
vi.mock('@/lib/app-config', () => ({ getConfig: () => getConfigMock() }));
vi.mock('@/lib/db', () => ({ isAuroraEnabled: () => isAuroraEnabledMock(), checkDbHealth: () => checkDbHealthMock() }));
vi.mock('@/lib/db/drift', () => ({ getDriftCounters: () => getDriftCountersMock() }));
vi.mock('@/lib/db/agentcore-stats-writer', () => ({ countAuroraCalls: (...args: unknown[]) => countAuroraCallsMock(...args) }));
vi.mock('@/lib/agentcore-stats', () => ({ getStats: () => getStatsMock() }));
vi.mock('@/lib/event-scaling', () => ({ listEvents: (...args: unknown[]) => listEventsMock(...args) }));
vi.mock('@/lib/db/event-scaling-writer', () => ({
  readEventsFromAurora: () => readEventsFromAuroraMock(),
  countAuroraEvents: () => countAuroraEventsMock(),
}));
vi.mock('@/lib/db/alert-diagnosis-writer', () => ({ countAuroraDiagnoses: () => countAuroraDiagnosesMock() }));
vi.mock('@/lib/alert-knowledge-fs', () => ({ countJsonDiagnoses: () => countJsonDiagnosesMock() }));
vi.mock('@/lib/agentcore-memory', () => ({
  getConversations: (limit?: number, userId?: string) => getConversationsMock(limit, userId),
}));
vi.mock('@/lib/db/agentcore-memory-writer', () => ({ countAuroraMemory: (sub?: string) => countAuroraMemoryMock(sub) }));
vi.mock('@/lib/inventory-fs', () => ({ countJsonInventoryDays: () => countJsonInventoryDaysMock() }));
vi.mock('@/lib/db/inventory-writer', () => ({
  countAuroraInventoryRows: (opts?: { distinct?: boolean }) => countAuroraInventoryRowsMock(opts),
}));

import { GET } from '@/app/api/parity/route';

function makeReq(url = 'http://x/api/parity'): NextRequest { return new NextRequest(new URL(url)); }
function adminUser() { return { email: 'admin@example.com', sub: 'admin', groups: [] }; }
function configWithAdmin() { return { adminEmails: ['admin@example.com'] }; }
function configFreshInstall() { return { adminEmails: [] }; }

describe('parity route — GET /api/parity', () => {
  beforeEach(() => {
    [getUserFromRequestMock, getConfigMock, isAuroraEnabledMock, checkDbHealthMock,
     getDriftCountersMock, countAuroraCallsMock, getStatsMock, listEventsMock,
     readEventsFromAuroraMock, countAuroraEventsMock, countAuroraDiagnosesMock,
     countJsonDiagnosesMock, getConversationsMock, countAuroraMemoryMock,
     countJsonInventoryDaysMock, countAuroraInventoryRowsMock].forEach((m) => m.mockReset());

    listEventsMock.mockReturnValue([]);
    readEventsFromAuroraMock.mockResolvedValue([]);
    countAuroraEventsMock.mockResolvedValue(0);
    countAuroraDiagnosesMock.mockResolvedValue(0);
    countJsonDiagnosesMock.mockReturnValue(0);
    getConversationsMock.mockResolvedValue([]);
    countAuroraMemoryMock.mockResolvedValue(0);
    countJsonInventoryDaysMock.mockReturnValue(0);
    countAuroraInventoryRowsMock.mockResolvedValue(0);

    getUserFromRequestMock.mockReturnValue(adminUser());
    getConfigMock.mockReturnValue(configWithAdmin());
    isAuroraEnabledMock.mockReturnValue(true);
    checkDbHealthMock.mockResolvedValue({ ok: true, schemaVersion: 1 });
    getDriftCountersMock.mockReturnValue([]);
    countAuroraCallsMock.mockResolvedValue(0);
    getStatsMock.mockReturnValue({
      recentCalls: [], totalCalls: 0, successCalls: 0, failedCalls: 0,
      avgResponseTimeMs: 0, totalToolsUsed: 0, uniqueToolsUsed: [],
      callsByGateway: {}, callsByRoute: {}, lastUpdated: new Date().toISOString(),
      totalInputTokens: 0, totalOutputTokens: 0, tokensByModel: {},
    });
  });

  it('returns 403 when caller is not an admin', async () => {
    getUserFromRequestMock.mockReturnValue({ email: 'bob@example.com', sub: 'bob', groups: [] });
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it('treats fresh installs (empty adminEmails) as admin', async () => {
    getUserFromRequestMock.mockReturnValue({ email: 'anonymous', sub: 'x', groups: [] });
    getConfigMock.mockReturnValue(configFreshInstall());
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it('returns auroraEnabled:false when not configured', async () => {
    isAuroraEnabledMock.mockReturnValue(false);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.auroraEnabled).toBe(false);
    expect(body.message).toMatch(/AURORA_DATABASE_URL|AURORA_HOST/);
  });

  it('returns health, drift, and parity arrays when enabled', async () => {
    getDriftCountersMock.mockReturnValue([
      { source: 'agentcore_stats', writes: 5, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
    ]);
    countAuroraCallsMock.mockResolvedValue(5);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.auroraEnabled).toBe(true);
    expect(body.health).toEqual({ ok: true, schemaVersion: 1 });
    expect(Array.isArray(body.parity)).toBe(true);
  });

  it('clamps the hours param into [1, 168]', async () => {
    await GET(makeReq('http://x/api/parity?hours=9999'));
    let [since, until] = countAuroraCallsMock.mock.calls.at(-1)!;
    expect((until.getTime() - since.getTime()) / 3_600_000).toBe(168);
    await GET(makeReq('http://x/api/parity?hours=0'));
    [since, until] = countAuroraCallsMock.mock.calls.at(-1)!;
    expect((until.getTime() - since.getTime()) / 3_600_000).toBe(1);
  });

  it('?source=agentcore_stats filters drift', async () => {
    getDriftCountersMock.mockReturnValue([
      { source: 'agentcore_stats', writes: 5, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
      { source: 'inventory_snapshots', writes: 2, failures: 1, failureRate: 0.33, lastFailureAt: 't', lastFailureMessage: 'm' },
    ]);
    const res = await GET(makeReq('http://x/api/parity?source=agentcore_stats'));
    const body = await res.json();
    expect(body.drift).toHaveLength(1);
    expect(body.drift[0].source).toBe('agentcore_stats');
  });

  it('computes |auroraCount - jsonRecentCalls| as drift', async () => {
    countAuroraCallsMock.mockResolvedValue(7);
    const now = Date.now();
    getStatsMock.mockReturnValue({
      recentCalls: [
        { timestamp: new Date(now - 30 * 60_000).toISOString() },
        { timestamp: new Date(now - 5 * 60_000).toISOString() },
        { timestamp: new Date(now - 25 * 3_600_000).toISOString() },
      ],
      totalCalls: 0, successCalls: 0, failedCalls: 0, avgResponseTimeMs: 0,
      totalToolsUsed: 0, uniqueToolsUsed: [], callsByGateway: {}, callsByRoute: {},
      lastUpdated: new Date().toISOString(),
      totalInputTokens: 0, totalOutputTokens: 0, tokensByModel: {},
    });
    const res = await GET(makeReq());
    const body = await res.json();
    const p = body.parity.find((x: { source: string }) => x.source === 'agentcore_stats');
    expect(p.drift).toBe(5);
  });

  describe('per-source parity', () => {
    const sources = [
      { source: 'event_scaling_plans', mockJson: listEventsMock, mockAur: countAuroraEventsMock, jsonShape: (n: number) => Array(n).fill({ eventId: 'x' }) },
      { source: 'alert_diagnosis', mockJson: countJsonDiagnosesMock, mockAur: countAuroraDiagnosesMock, jsonShape: (n: number) => n },
      { source: 'agentcore_memory', mockJson: getConversationsMock, mockAur: countAuroraMemoryMock, jsonShape: (n: number) => Array(n).fill({ id: 'x' }) },
      { source: 'inventory_snapshots', mockJson: countJsonInventoryDaysMock, mockAur: countAuroraInventoryRowsMock, jsonShape: (n: number) => n },
    ];

    for (const { source, mockJson, mockAur, jsonShape } of sources) {
      describe(source, () => {
        it(`is in the default parity array`, async () => {
          const body = await (await GET(makeReq())).json();
          expect(body.parity.map((p: { source: string }) => p.source)).toContain(source);
        });

        it(`inSync:true on count match`, async () => {
          const shape = jsonShape(3);
          if (typeof shape === 'number') mockJson.mockReturnValue(shape);
          else mockJson.mockReturnValueOnce(shape).mockResolvedValueOnce(shape);
          mockAur.mockResolvedValue(3);
          const body = await (await GET(makeReq())).json();
          const p = body.parity.find((x: { source: string }) => x.source === source);
          expect(p.inSync).toBe(true);
          expect(p.drift).toBe(0);
        });

        it(`inSync:false on count mismatch`, async () => {
          const shape = jsonShape(2);
          if (typeof shape === 'number') mockJson.mockReturnValue(shape);
          else mockJson.mockReturnValueOnce(shape).mockResolvedValueOnce(shape);
          mockAur.mockResolvedValue(5);
          const body = await (await GET(makeReq())).json();
          const p = body.parity.find((x: { source: string }) => x.source === source);
          expect(p.inSync).toBe(false);
          expect(p.drift).toBe(3);
        });

        it(`?source=${source} filters parity + drift`, async () => {
          getDriftCountersMock.mockReturnValue([
            { source: 'agentcore_stats', writes: 5, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
            { source, writes: 2, failures: 0, failureRate: 0, lastFailureAt: null, lastFailureMessage: null },
          ]);
          const body = await (await GET(makeReq(`http://x/api/parity?source=${source}`))).json();
          expect(body.parity).toHaveLength(1);
          expect(body.parity[0].source).toBe(source);
          expect(body.drift).toHaveLength(1);
          expect(body.drift[0].source).toBe(source);
        });
      });
    }
  });
});
