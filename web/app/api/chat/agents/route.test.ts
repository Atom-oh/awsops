import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  verifyUser: vi.fn(), getAccount: vi.fn(), getCustomAgentContext: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verifyUser }));
vi.mock('@/lib/accounts', () => ({ getAccount: mocks.getAccount, validateAccountId: (v: string) => /^\d{12}$/.test(v) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => '111111111111' }));
vi.mock('@/lib/catalog-source', () => ({ getCustomAgentContext: mocks.getCustomAgentContext }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('HYBRID_ROUTING_ENABLED', 'true');
  mocks.verifyUser.mockResolvedValue({ sub: 'reader' });
  mocks.getAccount.mockResolvedValue({ enabled: true });
  mocks.getCustomAgentContext.mockResolvedValue({ status: 'available', space: null, agents: [{ name: 'sre-2', gateway: 'ops', persona: 'private instructions' }] });
});
afterEach(() => vi.unstubAllEnvs());
const request = (account = 'self') => new Request(`http://local/api/chat/agents?accountId=${account}`);

it('requires authentication and respects the existing routing gate', async () => {
  const { GET } = await import('./route');
  mocks.verifyUser.mockResolvedValueOnce(null);
  expect((await GET(request())).status).toBe(401);
  vi.stubEnv('HYBRID_ROUTING_ENABLED', 'false');
  expect(await (await GET(request())).json()).toEqual({ enabled: false, agents: [] });
  expect(mocks.getCustomAgentContext).not.toHaveBeenCalled();
});
it('lists only account-scoped command names without persona or credential data', async () => {
  const { GET } = await import('./route');
  expect(await (await GET(request('222222222222'))).json()).toEqual({
    enabled: true, agents: [{ key: 'sre-2', label: 'sre-2', icon: '', active: true }],
  });
  expect(mocks.getCustomAgentContext).toHaveBeenCalledWith('222222222222');
});
it('rejects an unregistered or disabled foreign account', async () => {
  const { GET } = await import('./route');
  mocks.getAccount.mockResolvedValue(undefined);
  expect((await GET(request('222222222222'))).status).toBe(404);
  expect(mocks.getCustomAgentContext).not.toHaveBeenCalled();
});
it('uses the shared reserved-name policy including code', async () => {
  mocks.getCustomAgentContext.mockResolvedValue({ status: 'available', space: null, agents: ['code', 'auto', 'security', 'sre-2'].map(name => ({ name })) });
  const { GET } = await import('./route');
  const body = await (await GET(request())).json();
  expect(body.agents.map((a: { key: string }) => a.key)).toEqual(['sre-2']);
});

it('reports an unavailable context without returning stale command names', async () => {
  mocks.getCustomAgentContext.mockResolvedValue({ status: 'unavailable', space: null, agents: [] });
  const { GET } = await import('./route');
  expect((await GET(request())).status).toBe(503);
});
