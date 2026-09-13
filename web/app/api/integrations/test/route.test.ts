import { beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ verifyUser: vi.fn(), isAdmin: vi.fn(), invoke: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: auth.verifyUser }));
vi.mock('@/lib/admin', () => ({ isAdmin: auth.isAdmin }));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: auth.invoke }));
const request = (body: unknown = { kind: 'notion' }) => new Request('http://localhost/api/integrations/test', {
  method: 'POST', body: JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks();
  auth.verifyUser.mockResolvedValue({ sub: 'admin' });
  auth.isAdmin.mockResolvedValue(true);
  auth.invoke.mockResolvedValue({ ok: true, privateData: 'must-not-return' });
});

it('checks administrator authorization before invoking a connector', async () => {
  const { POST } = await import('./route');
  auth.verifyUser.mockResolvedValueOnce(null);
  expect((await POST(request())).status).toBe(401);
  auth.isAdmin.mockResolvedValueOnce(false);
  expect((await POST(request())).status).toBe(403);
  expect(auth.invoke).not.toHaveBeenCalled();
});

it('uses only the fixed Notion health tool and returns no identity or credential data', async () => {
  const { POST } = await import('./route');
  expect(await (await POST(request())).json()).toEqual({ ok: true });
  expect(auth.invoke).toHaveBeenCalledWith({ kind: 'notion', tool: 'notion_health' });
  expect((await POST(request({ kind: 'slack', tool: 'post_message' }))).status).toBe(400);
});

it('fails safely for malformed input and never reflects an upstream token', async () => {
  const { POST } = await import('./route');
  expect((await POST(request(null))).status).toBe(400);
  auth.invoke.mockRejectedValue(new Error('token supersecret'));
  const response = await POST(request());
  expect(await response.json()).toEqual({ ok: false });
});
