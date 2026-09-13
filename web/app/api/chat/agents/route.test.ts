import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  verifyUser: vi.fn(), getAccount: vi.fn(), getEnabledCustomAgents: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verifyUser }));
vi.mock('@/lib/accounts', () => ({ getAccount: mocks.getAccount, validateAccountId: (v: string) => /^\d{12}$/.test(v) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => '111111111111' }));
vi.mock('@/lib/catalog-source', () => ({ getEnabledCustomAgents: mocks.getEnabledCustomAgents }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('HYBRID_ROUTING_ENABLED', 'true');
  mocks.verifyUser.mockResolvedValue({ sub: 'reader' });
  mocks.getAccount.mockResolvedValue({ enabled: true });
  mocks.getEnabledCustomAgents.mockResolvedValue([{ name: 'sre-2', gateway: 'ops', persona: 'private instructions' }]);
});
afterEach(() => vi.unstubAllEnvs());
const request = (account = 'self') => new Request(`http://local/api/chat/agents?accountId=${account}`);

it('requires authentication and respects the existing routing gate', async () => {
  const { GET } = await import('./route');
  mocks.verifyUser.mockResolvedValueOnce(null);
  expect((await GET(request())).status).toBe(401);
  vi.stubEnv('HYBRID_ROUTING_ENABLED', 'false');
  expect(await (await GET(request())).json()).toEqual({ enabled: false, agents: [] });
  expect(mocks.getEnabledCustomAgents).not.toHaveBeenCalled();
});
it('lists only account-scoped command names without persona or credential data', async () => {
  const { GET } = await import('./route');
  expect(await (await GET(request('222222222222'))).json()).toEqual({
    enabled: true, agents: [{ key: 'sre-2', label: 'sre-2', icon: '', active: true }],
  });
  expect(mocks.getEnabledCustomAgents).toHaveBeenCalledWith('222222222222');
});
it('rejects an unregistered or disabled foreign account', async () => {
  const { GET } = await import('./route');
  mocks.getAccount.mockResolvedValue(undefined);
  expect((await GET(request('222222222222'))).status).toBe(404);
  expect(mocks.getEnabledCustomAgents).not.toHaveBeenCalled();
});
