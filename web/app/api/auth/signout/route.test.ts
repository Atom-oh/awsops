import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUserForSignout = vi.fn();
const revokeSessionsFor = vi.fn();
vi.mock('@/lib/auth', () => ({
  verifyUserForSignout: (...a: unknown[]) => verifyUserForSignout(...a),
  revokeSessionsFor: (...a: unknown[]) => revokeSessionsFor(...a),
}));

const req = (cookie = 'awsops_token=t') => new Request('http://x/api/auth/signout', { method: 'POST', headers: { cookie } });

beforeEach(() => {
  verifyUserForSignout.mockReset();
  revokeSessionsFor.mockReset();
  revokeSessionsFor.mockResolvedValue(undefined);
});

describe('POST /api/auth/signout', () => {
  it('clears the awsops_token cookie (Max-Age=0)', async () => {
    verifyUserForSignout.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('awsops_token=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });
  it("returns { redirect: '/login' } (no hosted-UI round-trip)", async () => {
    verifyUserForSignout.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(await res.json()).toEqual({ redirect: '/login' });
  });

  // pentest-remediation P1-1 (Finding 1): logout used to be a pure client-side cookie clear — the
  // id_token itself stayed valid for its full ~12h remaining lifetime. Signout now best-effort
  // records a server-side revocation for the token's sub.
  it('revokes sessions for the signed-out user (even an already-expired token — that is the point)', async () => {
    verifyUserForSignout.mockResolvedValue({ sub: 'u-1' });
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(revokeSessionsFor).toHaveBeenCalledWith('u-1');
  });
  it('does not attempt revocation when there is no verifiable token (no cookie, forged, etc.)', async () => {
    verifyUserForSignout.mockResolvedValue(null);
    const { POST } = await import('./route');
    await POST(req());
    expect(revokeSessionsFor).not.toHaveBeenCalled();
  });
  it('still clears the cookie and returns 200 even if the revocation write fails (best-effort)', async () => {
    verifyUserForSignout.mockResolvedValue({ sub: 'u-1' });
    revokeSessionsFor.mockRejectedValue(new Error('db down'));
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await res.json()).toEqual({ redirect: '/login' });
  });
  it('still succeeds even if verifyUserForSignout itself throws', async () => {
    verifyUserForSignout.mockRejectedValue(new Error('jwks fetch failed'));
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(revokeSessionsFor).not.toHaveBeenCalled();
  });
});
