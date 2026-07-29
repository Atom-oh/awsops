import { describe, it, expect, vi, beforeEach } from 'vitest';

const jwtVerify = vi.fn();
vi.mock('jose', () => ({
  createRemoteJWKSet: () => () => ({}),
  jwtVerify: (...a: unknown[]) => jwtVerify(...a),
}));

const query = vi.fn();
vi.mock('./db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const NOW = 1_700_000_000; // arbitrary fixed epoch seconds for iat/revoked_at comparisons

beforeEach(() => {
  jwtVerify.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [] }); // default: no revocation row → not revoked
  process.env.COGNITO_USER_POOL_ID = 'ap-northeast-2_TEST';
  process.env.COGNITO_CLIENT_ID = 'client123';
  process.env.AWS_REGION = 'ap-northeast-2';
});

describe('verifyUser', () => {
  it('returns null when no cookie', async () => {
    const { verifyUser } = await import('./auth');
    expect(await verifyUser(null)).toBeNull();
  });
  it('returns null when awsops_token cookie absent', async () => {
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('foo=bar; baz=1')).toBeNull();
  });
  it('returns {sub,email} for a valid id token', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', email: 'a@b.com', token_use: 'id', iat: NOW } });
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...; x=1')).toEqual({ sub: 'u-1', email: 'a@b.com', groups: [] });
  });
  it('returns null when token_use is not id', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'access', iat: NOW } });
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
  });
  it('returns null when verification throws (expired/forged)', async () => {
    jwtVerify.mockRejectedValue(new Error('expired'));
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
  });

  // pentest-remediation P1-1 (Finding 1): server-side revocation-on-logout.
  describe('revocation', () => {
    it('rejects a token issued before (or at) the revocation cutoff', async () => {
      jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id', iat: NOW } });
      query.mockResolvedValue({ rows: [{ revoked_at: new Date((NOW + 1) * 1000).toISOString() }] });
      const { verifyUser } = await import('./auth');
      expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
    });
    it('accepts a token issued AFTER the revocation cutoff (re-login post-logout)', async () => {
      jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id', iat: NOW } });
      query.mockResolvedValue({ rows: [{ revoked_at: new Date((NOW - 1) * 1000).toISOString() }] });
      const { verifyUser } = await import('./auth');
      expect(await verifyUser('awsops_token=eyJ...')).not.toBeNull();
    });
    it('rejects a token with no iat claim (fail closed on a malformed/unexpected shape)', async () => {
      jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id' } });
      const { verifyUser } = await import('./auth');
      expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
    });
    it('fails OPEN (does not block login) when the revocation-check DB query throws', async () => {
      jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id', iat: NOW } });
      query.mockRejectedValue(new Error('db down'));
      const { verifyUser } = await import('./auth');
      expect(await verifyUser('awsops_token=eyJ...')).not.toBeNull();
    });
    it('queries session_revocations scoped to the token sub', async () => {
      jwtVerify.mockResolvedValue({ payload: { sub: 'u-42', token_use: 'id', iat: NOW } });
      const { verifyUser } = await import('./auth');
      await verifyUser('awsops_token=eyJ...');
      expect(query).toHaveBeenCalledWith(expect.stringContaining('session_revocations'), ['u-42']);
    });
  });
});

describe('revokeSessionsFor', () => {
  it('upserts a revocation row for the given sub', async () => {
    const { revokeSessionsFor } = await import('./auth');
    await revokeSessionsFor('u-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (user_sub) DO UPDATE'), ['u-1']);
  });
});

describe('verifyUserForSignout', () => {
  it('returns null when no cookie', async () => {
    const { verifyUserForSignout } = await import('./auth');
    expect(await verifyUserForSignout(null)).toBeNull();
  });
  it('accepts a token jwtVerify would reject for a fresh verifyUser call ONLY because it is expired', async () => {
    // Simulate: the mocked jwtVerify call succeeds because we pass clockTolerance — we can't
    // actually exercise jose's real expiry math against a mock, so this asserts the call site
    // wires clockTolerance through (the behavior jose then enforces).
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id' } });
    const { verifyUserForSignout } = await import('./auth');
    const user = await verifyUserForSignout('awsops_token=eyJ...');
    expect(user).toEqual({ sub: 'u-1' });
    const [, , opts] = jwtVerify.mock.calls.at(-1) as [unknown, unknown, { clockTolerance?: unknown }];
    expect(opts.clockTolerance).toBeTruthy();
  });
  it('still rejects on signature/issuer/audience failure (cannot be forged)', async () => {
    jwtVerify.mockRejectedValue(new Error('signature verification failed'));
    const { verifyUserForSignout } = await import('./auth');
    expect(await verifyUserForSignout('awsops_token=eyJ...')).toBeNull();
  });
  it('rejects a non-id token_use', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'access' } });
    const { verifyUserForSignout } = await import('./auth');
    expect(await verifyUserForSignout('awsops_token=eyJ...')).toBeNull();
  });
  it('does NOT check revocation (signout must work even for an already-revoked/expired session)', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id' } });
    const { verifyUserForSignout } = await import('./auth');
    await verifyUserForSignout('awsops_token=eyJ...');
    expect(query).not.toHaveBeenCalled();
  });
});
