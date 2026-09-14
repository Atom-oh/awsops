import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/auth', () => ({ verifyUser: async (cookie: string) =>
  ['user-a', 'user-b'].includes(cookie) ? { sub: cookie } : null }));
vi.mock('@/lib/agentcore-status', () => ({ getAgentCoreStatus: () => { throw new Error('No AWS'); } }));
import { GET as chatStats } from '@/app/api/chat/stats/route';
import { GET as agentStats } from '@/app/api/agentcore/route';
import { recordChatInvoke } from './trace';

const evidence = { version: 1, status: 'partial', truncated: true, domains: [{
  gateway: 'network', status: 'partial', truncated: true, receipts: [{ version: 1,
    callId: 'private-call', tool: 'private-tool', outcome: 'success', observedAt: 111, terminalObservedAt: 222,
    inputs: { resource_id: 'eni-private', target_account_id: '123456789012' },
    requestedScope: { accountId: '123456789012' }, observedScope: {},
    quality: { collection: { status: 'ok', sources: [{ sourceId: 'private-source', status: 'ok' }] } },
  }],
}] };
let rows: any[];
beforeEach(() => {
  vi.stubEnv('AURORA_ENDPOINT', 'fixture');
  rows = [{ gateway: 'network', user_sub: 'user-a', duration_ms: 10, occurred_at: '2026-09-14T00:00:00Z',
    payload: { success: true, status: 'success', evidence } }]; // historical receipt-bearing row
  query.mockReset().mockImplementation(async (sql: string, params: any[]) => {
    if (sql.includes('INSERT')) {
      rows.push({ gateway: params[1], user_sub: params[3], duration_ms: params[4], occurred_at: '2026-09-14T00:00:00Z', payload: JSON.parse(params[7]) });
      return { rows: [] };
    }
    return { rows: sql.includes('GROUP BY') ? [] : rows };
  });
});
afterEach(() => vi.unstubAllEnvs());

it('writes only coarse outcomes and omission flags to the global stats table', async () => {
  await recordChatInvoke({ gateway: 'network', userSub: 'user-a', elapsedMs: 20, success: true, evidence: evidence as any });
  expect(rows[1].payload).toMatchObject({ status: 'partial', success: false, evidenceOmitted: true });
  expect(rows[1].payload).not.toHaveProperty('evidence');
  expect(JSON.stringify(rows[1].payload)).not.toMatch(/private-|123456789012|observedAt|requestedScope/);
});
it.each([[chatStats, '/api/chat/stats'], [agentStats, '/api/agentcore?action=stats']] as const)(
  'global route %# exposes no private receipts to either authenticated user', async (GET, path) => {
    await recordChatInvoke({ gateway: 'network', userSub: 'user-a', elapsedMs: 20, success: true, evidence: evidence as any });
    for (const user of ['user-a', 'user-b']) {
      const response = await GET(new Request(`http://local${path}`, { headers: { cookie: user } }));
      expect(response.status).toBe(200);
      const stats = await response.json();
      expect(stats.recent).toHaveLength(2);
      for (const row of stats.recent) {
        expect(row).toMatchObject({ status: 'partial', success: false, evidenceOmitted: true });
        expect(row).not.toHaveProperty('evidence');
      }
      expect(JSON.stringify(stats)).not.toMatch(/private-|123456789012|observedAt|requestedScope|user-a/);
    }
    expect((await GET(new Request(`http://local${path}`))).status).toBe(401);
  });
