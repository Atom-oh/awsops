import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listAccounts = vi.fn();
const getAccount = vi.fn();
const query = vi.fn();
const readJsonBounded = vi.fn();
const send = vi.fn();
const upsertAccountRegion = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/accounts', () => ({
  listAccounts: (...a: unknown[]) => listAccounts(...a),
  getAccount: (...a: unknown[]) => getAccount(...a),
  validateAccountId: (id: string) => /^\d{12}$/.test(id),
  ensureHostRow: async () => {},
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@/lib/http-body', () => ({ readJsonBounded: (...a: unknown[]) => readJsonBounded(...a) }));
vi.mock('@/lib/account-regions', () => ({ upsertAccountRegion: (...a: unknown[]) => upsertAccountRegion(...a) }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({ send })),
  AssumeRoleCommand: vi.fn((i: unknown) => ({ cmd: 'assume', i })),
  GetCallerIdentityCommand: vi.fn((i: unknown) => ({ cmd: 'ident', i })),
}));

const TARGET = '210987654321';
const req = (method = 'GET', url = 'http://x/api/accounts', cookie = 'awsops_token=t') =>
  new Request(url, { method, headers: { cookie } });
const validBody = { accountId: TARGET, alias: 'Prod', region: 'ap-northeast-2', externalId: 'ext-1' };

beforeEach(() => {
  vi.resetModules();
  verifyUser.mockReset(); isAdmin.mockReset(); listAccounts.mockReset();
  getAccount.mockReset(); query.mockReset(); readJsonBounded.mockReset(); send.mockReset(); upsertAccountRegion.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@b.c', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
  listAccounts.mockResolvedValue([]);
  query.mockResolvedValue({ rows: [], rowCount: 1 });
  readJsonBounded.mockResolvedValue(validBody);
  // AssumeRole then GetCallerIdentity(Account==TARGET)
  send.mockResolvedValueOnce({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'sk', SessionToken: 'tok' } })
      .mockResolvedValueOnce({ Account: TARGET });
});

describe('GET /api/accounts', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 lists accounts', async () => {
    listAccounts.mockResolvedValue([{ accountId: TARGET, alias: 'Prod' }]);
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.accounts).toHaveLength(1);
  });
});

describe('POST /api/accounts', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(401);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it('400 invalid account id', async () => {
    readJsonBounded.mockResolvedValue({ ...validBody, accountId: '123' });
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('200 without externalId (1st-party) → inserts external_id NULL, assume omits ExternalId', async () => {
    readJsonBounded.mockResolvedValue({ accountId: TARGET, alias: 'Prod', region: 'ap-northeast-2' });
    const sts = await import('@aws-sdk/client-sts');
    const { POST } = await import('./route');
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    // external_id param ($5 → index 4) persisted as NULL, never '' :
    expect(query.mock.calls[0][1][4]).toBeNull();
    // AssumeRole built WITHOUT an ExternalId field :
    const assumeArg = (sts.AssumeRoleCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect('ExternalId' in assumeArg).toBe(false);
  });
  it('400 when GetCallerIdentity.Account != submitted id (anti-spoof) — no insert', async () => {
    send.mockReset();
    send.mockResolvedValueOnce({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'sk', SessionToken: 'tok' } })
        .mockResolvedValueOnce({ Account: '999999999999' });
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('200 valid → inserts verified (with externalId)', async () => {
    const sts = await import('@aws-sdk/client-sts');
    const { POST } = await import('./route');
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]).toLowerCase();
    expect(sql).toContain('insert into accounts');
    expect(query.mock.calls[0][1][4]).toBe('ext-1');
    const assumeArg = (sts.AssumeRoleCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(assumeArg.ExternalId).toBe('ext-1');
    expect(upsertAccountRegion).toHaveBeenCalledWith(TARGET, 'ap-northeast-2');
  });
});

describe('DELETE /api/accounts', () => {
  it('400 deleting the host account', async () => {
    getAccount.mockResolvedValue({ accountId: TARGET, isHost: true });
    const { DELETE } = await import('./route');
    expect((await DELETE(req('DELETE', `http://x/api/accounts?accountId=${TARGET}`))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('200 deleting a target account', async () => {
    getAccount.mockResolvedValue({ accountId: TARGET, isHost: false });
    const { DELETE } = await import('./route');
    expect((await DELETE(req('DELETE', `http://x/api/accounts?accountId=${TARGET}`))).status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
