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
  it('upserts a revocation row bound to the given iat', async () => {
    const { revokeSessionsFor } = await import('./auth');
    await revokeSessionsFor('u-1', NOW);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (user_sub) DO UPDATE'), ['u-1', NOW]);
  });

  // pentest-remediation P2-review (MAJOR-1): replaying an already-revoked (but unexpired) token
  // against signout must not be able to push the cutoff past that token's own iat — otherwise a
  // captured, already-logged-out token can be replayed forever to roll-DoS every session the
  // victim creates afterward. Exercised at the SQL/param level since query is mocked (matches
  // this file's existing style for revokeSessionsFor/isRevoked).
  it('bounds the cutoff to the WHERE-guarded upsert so a replay with an older iat cannot re-advance a newer cutoff', async () => {
    const { revokeSessionsFor } = await import('./auth');
    // First call: a normal fresh logout, iat = NOW.
    await revokeSessionsFor('u-1', NOW);
    // "Replay" call: an attacker resubmits an older, already-revoked token (iat = NOW - 100).
    await revokeSessionsFor('u-1', NOW - 100);
    const [, params] = query.mock.calls.at(-1) as [string, [string, number]];
    const [sql] = query.mock.calls.at(-1) as [string, unknown];
    // The guard clause must be present and parameterized on the *replayed* call's own iat, so
    // Postgres — not this test — is what actually prevents the cutoff from moving backward: the
    // WHERE clause only lets the update through if the new cutoff is later than what's stored.
    expect(sql).toContain('WHERE session_revocations.revoked_at < to_timestamp($2)');
    expect(params).toEqual(['u-1', NOW - 100]);
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
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id', iat: NOW } });
    const { verifyUserForSignout } = await import('./auth');
    const user = await verifyUserForSignout('awsops_token=eyJ...');
    expect(user).toEqual({ sub: 'u-1', iat: NOW });
    const [, , opts] = jwtVerify.mock.calls.at(-1) as [unknown, unknown, { clockTolerance?: unknown }];
    expect(opts.clockTolerance).toBeTruthy();
  });
  it('still rejects on signature/issuer/audience failure (cannot be forged)', async () => {
    jwtVerify.mockRejectedValue(new Error('signature verification failed'));
    const { verifyUserForSignout } = await import('./auth');
    expect(await verifyUserForSignout('awsops_token=eyJ...')).toBeNull();
  });
  it('rejects a non-id token_use', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'access', iat: NOW } });
    const { verifyUserForSignout } = await import('./auth');
    expect(await verifyUserForSignout('awsops_token=eyJ...')).toBeNull();
  });
  // MAJOR-1 needs iat to bound revokeSessionsFor's cutoff — a token without one can't be
  // safely revoked-with-a-bound, so treat it like the other malformed-shape rejections.
  it('rejects a token with no iat claim (nothing to bound the revocation cutoff to)', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id' } });
    const { verifyUserForSignout } = await import('./auth');
    expect(await verifyUserForSignout('awsops_token=eyJ...')).toBeNull();
  });
  it('does NOT check revocation (signout must work even for an already-revoked/expired session)', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id', iat: NOW } });
    const { verifyUserForSignout } = await import('./auth');
    await verifyUserForSignout('awsops_token=eyJ...');
    expect(query).not.toHaveBeenCalled();
  });
  // pentest-remediation P1-review (MAJOR-1): clockTolerance must be short (minutes), not the
  // original 10-year value — otherwise anyone holding a long-expired token can replay it against
  // signout forever to keep force-logging-out the victim's *current* valid sessions.
  it('uses a short (minutes-scale) clockTolerance, not a multi-year one (logout-replay DoS)', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id', iat: NOW } });
    const { verifyUserForSignout } = await import('./auth');
    await verifyUserForSignout('awsops_token=eyJ...');
    const [, , opts] = jwtVerify.mock.calls.at(-1) as [unknown, unknown, { clockTolerance?: string }];
    expect(opts.clockTolerance).toMatch(/minute/);
  });
  it('rejects (via jose) a token expired well beyond the tolerance window', async () => {
    // jose itself enforces clockTolerance against real exp math; simulate that rejection here
    // since jwtVerify is mocked — this documents the boundary the real library enforces.
    jwtVerify.mockRejectedValue(new Error('"exp" claim timestamp check failed'));
    const { verifyUserForSignout } = await import('./auth');
    expect(await verifyUserForSignout('awsops_token=eyJ...')).toBeNull();
  });
});

describe('isRevoked timeout (via verifyUser)', () => {
  it('fails open when the revocation-check query hangs past the timeout', async () => {
    vi.useFakeTimers();
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'id', iat: NOW } });
    query.mockReturnValue(new Promise(() => {})); // never resolves — simulate a hung DB query
    const { verifyUser } = await import('./auth');
    const p = verifyUser('awsops_token=eyJ...');
    await vi.advanceTimersByTimeAsync(3100);
    expect(await p).not.toBeNull();
    vi.useRealTimers();
  });
});
