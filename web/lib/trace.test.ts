// web/lib/trace.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
import { recordCustomAgentTrace, recordChatInvoke, getChatInvokeStats } from './trace';

beforeEach(() => { query.mockReset(); delete process.env.AURORA_ENDPOINT; });

describe('chat evidence stats', () => {
  it('persists a known partial domain and never accepts a conflicting success boolean', async () => {
    process.env.AURORA_ENDPOINT = 'fixture';
    query.mockResolvedValue({ rows: [] });
    await recordChatInvoke({ gateway: 'network', userSub: 'u', elapsedMs: 25, success: true,
      evidence: { version: 1, status: 'partial', domains: [
        { gateway: 'network', status: 'unverified', receipts: [] },
        { gateway: 'data', status: 'error', receipts: [] },
      ], secret: 'SECRET' } } as any);
    const payload = JSON.parse(query.mock.calls[0][1].at(-1));
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('partial');
    expect(payload).not.toHaveProperty('evidence');
    expect(JSON.stringify(payload)).not.toContain('SECRET');
  });
  it('keeps legacy text success unknown and weights success only by assessed calls', async () => {
    process.env.AURORA_ENDPOINT = 'fixture';
    query.mockResolvedValueOnce({ rows: [
      { gateway: 'network', calls: 10, assessed_calls: 2, success_rate: 0.5, avg_ms: 100 },
      { gateway: 'data', calls: 2, assessed_calls: 0, success_rate: null, avg_ms: 200 },
    ] }).mockResolvedValueOnce({ rows: [
      { gateway: 'network', payload: { success: true }, occurred_at: '2026-09-14T00:00:00Z' },
      { gateway: 'data', payload: { success: false }, occurred_at: '2026-09-14T00:00:00Z' },
    ] });
    const stats = await getChatInvokeStats();
    expect(stats.successRate).toBe(0.5);
    expect((stats as any).unverifiedCalls).toBe(10);
    expect(stats.recent[0]).toMatchObject({ success: null, status: 'unverified' });
    expect(stats.recent[1]).toMatchObject({ success: false, status: 'error' });
  });
});

describe('recordCustomAgentTrace', () => {
  it('no-ops when Aurora unconfigured', async () => {
    await recordCustomAgentTrace({ gateway: 'security', userSub: 'u', agentName: 'compliance', tier: 'custom', skillHashes: ['h1'] });
    expect(query).not.toHaveBeenCalled();
  });
  it('inserts into agentcore_stats with traceability payload', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    query.mockResolvedValue({ rows: [] });
    await recordCustomAgentTrace({ gateway: 'security', userSub: 'u', agentName: 'compliance', agentVersion: 3, tier: 'custom', skillHashes: ['h1', 'h2'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO agentcore_stats/i);
    expect(params).toContain('custom_agent_invoke');
    const payload = JSON.parse(params[params.length - 1]);
    expect(payload.agentName).toBe('compliance');
    expect(payload.skillHashes).toEqual(['h1', 'h2']);
  });
  it('carries spaceVersion into the payload (ADR-031 Phase 2)', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    query.mockResolvedValue({ rows: [] });
    await recordCustomAgentTrace({ gateway: 'security', userSub: 'u', agentName: 'compliance', agentVersion: 3, tier: 'custom', skillHashes: ['h1'], spaceVersion: 7 });
    const params = query.mock.calls[0][1];
    const payload = JSON.parse(params[params.length - 1]);
    expect(payload.spaceVersion).toBe(7);
  });
  it('never throws on DB error', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    query.mockRejectedValue(new Error('down'));
    await expect(recordCustomAgentTrace({ gateway: 'g', userSub: 'u', agentName: 'a', tier: 'custom', skillHashes: [] })).resolves.toBeUndefined();
  });
});

it.each([null, { version: 99, domains: [] }, { version: 1, domains: 'PRIVATE' }])(
  'does not trust a legacy success alongside unsupported evidence: %j', async evidence => {
    process.env.AURORA_ENDPOINT = 'fixture';
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      gateway: 'network', occurred_at: '2026-09-14T00:00:00Z', payload: { status: 'success', success: true, evidence },
    }] });
    const stats = await getChatInvokeStats();
    expect(stats.recent[0]).toMatchObject({ status: 'unverified', success: null, evidenceOmitted: true });
    expect(JSON.stringify(stats)).not.toContain('PRIVATE');
  });
it.each(['error', 'partial', 'empty', 'unverified', 'success'] as const)(
  'coarse persisted %s is restored without private receipt details', async status => {
    process.env.AURORA_ENDPOINT = 'fixture';
    query.mockResolvedValue({ rows: [] });
    await recordChatInvoke({ gateway: 'network', userSub: 'u', elapsedMs: 1, success: true, evidence: {
      version: 1, status, domains: [{ gateway: 'network', status, completion: { version: 1, receiptCount: 1 }, receipts: [{
        version: 1, callId: 'a', tool: 'inspect', observedAt: 1000, terminalObservedAt: 2000,
        outcome: status, inputs: {}, requestedScope: {}, observedScope: {},
      }] }],
    } });
    const payload = JSON.parse(query.mock.calls[0][1].at(-1));
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ gateway: 'network',
      occurred_at: '2026-09-14T00:00:00Z', payload }] });
    const stats = await getChatInvokeStats();
    expect(stats.recent[0].status).toBe(status);
    expect(payload).not.toHaveProperty('evidence');
  });


it('aggregate SQL does not count historical receipt-bearing successes as confirmed', async () => {
  process.env.AURORA_ENDPOINT = 'fixture';
  query.mockResolvedValue({ rows: [] });
  await getChatInvokeStats();
  const sql = query.mock.calls[0][0] as string;
  const expression = sql.match(/SELECT gateway, duration_ms,\s*([\s\S]+?) AS status/)![1];
  // Execute the emitted CASE using the shared JSON ->/->> operator subset. No tables, files or network.
  const script = `
import json,sqlite3,sys
expression,payloads=json.load(sys.stdin)
connection=sqlite3.connect(':memory:')
print(json.dumps([connection.execute('SELECT '+expression+' FROM (SELECT ? AS payload)',
    (json.dumps(payload),)).fetchone()[0] for payload in payloads]))
`;
  const payloads = [
    { status: 'success', evidence: { version: 1, status: 'success', domains: [] } },
    { status: 'success', evidence: { version: 99 } },
    { status: 'success', evidence: null },
    { status: 'partial', evidence: { version: 1, status: 'partial' } },
    { status: 'error', evidence: { version: 1, status: 'error' } },
    { status: 'success' }, { status: 'unverified' },
  ];
  const actual = JSON.parse(execFileSync('python3', ['-B', '-c', script], {
    input: JSON.stringify([expression, payloads]), encoding: 'utf8',
  }));
  expect(actual).toEqual(['unverified', 'unverified', 'unverified', 'partial', 'error', 'success', 'unverified']);
});
