import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyUser, send } = vi.hoisted(() => ({ verifyUser: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@aws-sdk/client-cloudtrail', () => ({
  CloudTrailClient: class { send = (...a: unknown[]) => send(...a); },
  LookupEventsCommand: class { constructor(public input: unknown) {} },
}));

import { GET } from './route';

const req = (q = '') => new Request(`http://x/api/inventory/cloudtrail/events${q}`, {
  headers: { cookie: 'awsops_token=t' },
});

beforeEach(() => {
  verifyUser.mockReset(); send.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u1' });
});

describe('GET /api/inventory/cloudtrail/events', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('maps the drill-down fields from the same LookupEvents response (gap L62)', async () => {
    send.mockResolvedValue({ Events: [{
      EventId: 'ev-1', EventName: 'RunInstances', EventSource: 'ec2.amazonaws.com',
      Username: 'alice', EventTime: new Date('2026-09-01T00:00:00Z'),
      Resources: [
        { ResourceType: 'AWS::EC2::Instance', ResourceName: 'i-1' },
        { ResourceType: 'AWS::EC2::Volume', ResourceName: 'vol-1' },
      ],
      CloudTrailEvent: JSON.stringify({
        readOnly: false, awsRegion: 'ap-northeast-2', sourceIPAddress: '10.0.0.1',
        userAgent: 'aws-cli/2', errorCode: 'AccessDenied', requestParameters: { x: 1 },
      }),
    }] });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const e = (await res.json()).events[0];
    expect(e).toMatchObject({
      eventId: 'ev-1', readOnly: false, awsRegion: 'ap-northeast-2',
      sourceIPAddress: '10.0.0.1', userAgent: 'aws-cli/2', errorCode: 'AccessDenied',
    });
    // ALL resources survive (the table shows only the first; the panel lists every one)
    expect(e.resources).toEqual([
      { type: 'EC2::Instance', name: 'i-1' }, { type: 'EC2::Volume', name: 'vol-1' },
    ]);
    expect(e.raw.requestParameters).toEqual({ x: 1 });
  });

  it('malformed CloudTrailEvent JSON → row still renders (raw null, readOnly defaults true)', async () => {
    send.mockResolvedValue({ Events: [{
      EventId: 'ev-2', EventName: 'X', EventSource: 's', CloudTrailEvent: 'not json {',
    }] });
    const e = (await (await GET(req())).json()).events[0];
    expect(e.raw).toBeNull();
    expect(e.readOnly).toBe(true);
    expect(e.eventId).toBe('ev-2');
  });

  it('?write=1 adds the ReadOnly=false lookup attribute', async () => {
    send.mockResolvedValue({ Events: [] });
    await GET(req('?write=1'));
    const cmd = send.mock.calls[0][0] as { input: { LookupAttributes?: unknown[] } };
    expect(cmd.input.LookupAttributes).toEqual([{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }]);
  });
});
