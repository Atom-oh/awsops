import { describe, it, expect, vi, beforeEach } from 'vitest';

const jwtVerify = vi.fn();
vi.mock('jose', () => ({
  createRemoteJWKSet: () => () => ({}),
  jwtVerify: (...a: unknown[]) => jwtVerify(...a),
}));

beforeEach(() => {
  jwtVerify.mockReset();
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
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', email: 'a@b.com', token_use: 'id' } });
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...; x=1')).toEqual({ sub: 'u-1', email: 'a@b.com', groups: [] });
  });
  it('returns null when token_use is not id', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'access' } });
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
  });
  it('returns null when verification throws (expired/forged)', async () => {
    jwtVerify.mockRejectedValue(new Error('expired'));
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
  });
});

// PR #195 round-4 review MAJOR #1: matchesIdentity() is the legacy-row escape hatch — a report/job
// row written before the identity() switch (raw sub) must still resolve for its owner even after
// their token starts carrying an email that makes identity() diverge from sub.
describe('matchesIdentity', () => {
  it('matches a row keyed by identity() (email)', async () => {
    const { matchesIdentity } = await import('./auth');
    expect(matchesIdentity('u@x.io', { sub: 'u', email: 'u@x.io' })).toBe(true);
  });
  it('matches a legacy row keyed by the raw sub even when identity() now differs', async () => {
    const { matchesIdentity } = await import('./auth');
    expect(matchesIdentity('u', { sub: 'u', email: 'u@x.io' })).toBe(true);
  });
  it('does not match a different user’s row', async () => {
    const { matchesIdentity } = await import('./auth');
    expect(matchesIdentity('other@x.io', { sub: 'u', email: 'u@x.io' })).toBe(false);
  });
  it('fails closed on a null/empty owner', async () => {
    const { matchesIdentity } = await import('./auth');
    expect(matchesIdentity(null, { sub: 'u', email: 'u@x.io' })).toBe(false);
    expect(matchesIdentity('', { sub: 'u', email: 'u@x.io' })).toBe(false);
  });
});
