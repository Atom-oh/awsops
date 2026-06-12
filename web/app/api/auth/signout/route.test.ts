import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIG = { ...process.env };
beforeEach(() => {
  delete process.env.COGNITO_DOMAIN;
  delete process.env.COGNITO_CLIENT_ID;
  delete process.env.APP_DOMAIN;
});
afterEach(() => {
  process.env = { ...ORIG };
});

describe('POST /api/auth/signout', () => {
  it('clears the awsops_token cookie (Max-Age=0)', async () => {
    const { POST } = await import('./route');
    const res = await POST();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('awsops_token=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });
  it('builds the hosted-UI logout URL when env is set', async () => {
    process.env.COGNITO_DOMAIN = 'a-ops-v2-auth-x.auth.ap-northeast-2.amazoncognito.com';
    process.env.COGNITO_CLIENT_ID = 'client123';
    process.env.APP_DOMAIN = 'awsops-v2.atomai.click';
    const { POST } = await import('./route');
    const res = await POST();
    const { logoutUrl } = await res.json();
    expect(logoutUrl).toBe(
      'https://a-ops-v2-auth-x.auth.ap-northeast-2.amazoncognito.com/logout' +
        '?client_id=client123' +
        '&logout_uri=' + encodeURIComponent('https://awsops-v2.atomai.click/'),
    );
  });
  it("falls back to '/' when env is absent", async () => {
    const { POST } = await import('./route');
    const res = await POST();
    expect((await res.json()).logoutUrl).toBe('/');
  });
});
