import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyUser, isAdmin, topicArn, publishTest } = vi.hoisted(() => ({
  verifyUser: vi.fn(), isAdmin: vi.fn(), topicArn: vi.fn(), publishTest: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/diagnosis-notify', () => ({
  topicArn: (...a: unknown[]) => topicArn(...a),
  publishTest: (...a: unknown[]) => publishTest(...a),
}));

import { POST } from './route';

const req = () => new Request('http://x/api/diagnosis/subscribers/test', {
  method: 'POST', headers: { cookie: 'awsops_token=t' },
});

beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); topicArn.mockReset(); publishTest.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u1', email: 'admin@x.io' });
  isAdmin.mockReturnValue(true);
  topicArn.mockReturnValue('arn:aws:sns:ap-northeast-2:1:t');
  publishTest.mockResolvedValue('m1');
});

describe('POST /api/diagnosis/subscribers/test', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(publishTest).not.toHaveBeenCalled();
  });
  it('403 non-admin', async () => {
    isAdmin.mockReturnValue(false);
    expect((await POST(req())).status).toBe(403);
    expect(publishTest).not.toHaveBeenCalled();
  });
  it('404 when notifications are disabled (no topic ARN)', async () => {
    topicArn.mockReturnValue(null);
    expect((await POST(req())).status).toBe(404);
    expect(publishTest).not.toHaveBeenCalled();
  });
  it('publishes and returns the message id', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: 'm1' });
    expect(publishTest).toHaveBeenCalledWith('arn:aws:sns:ap-northeast-2:1:t', 'admin@x.io');
  });
  it('502 with the SDK error on a publish failure — never a silent success', async () => {
    publishTest.mockRejectedValue(new Error('boom'));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain('boom');
  });
});
