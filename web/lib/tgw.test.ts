import { describe, it, expect, vi, beforeEach } from 'vitest';

// REGION은 모듈 로드 시점에 읽으므로 import 전에 고정 (테스트 결정성 — vpce.test.ts 선례)
process.env.AWS_REGION = 'ap-northeast-2';

const ec2Send = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return ec2Send(cmd, this.cfg.region); }
  },
  DescribeTransitGatewayAttachmentsCommand: class { constructor(public input: unknown) {} },
  DescribeTransitGatewayRouteTablesCommand: class { constructor(public input: unknown) {} },
  DescribeTransitGatewayVpcAttachmentsCommand: class { constructor(public input: unknown) {} },
  SearchTransitGatewayRoutesCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(async () => {
  ec2Send.mockReset();
  const { _resetTgwCacheForTests } = await import('./tgw');
  _resetTgwCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function mockRegion(opts: {
  attachments?: unknown[];
  vpcAttachments?: unknown[];
  routeTables?: unknown[];
  routes?: unknown[];
  additionalRoutes?: boolean;
  failVpcAttachments?: boolean;
  failRegion?: string;
}) {
  ec2Send.mockImplementation(async (cmd: unknown, region: string) => {
    const c = cmd as Cmd;
    if (opts.failRegion && region === opts.failRegion) throw new Error('denied');
    switch (c.constructor.name) {
      case 'DescribeTransitGatewayAttachmentsCommand':
        return { TransitGatewayAttachments: opts.attachments ?? [] };
      case 'DescribeTransitGatewayVpcAttachmentsCommand':
        if (opts.failVpcAttachments) throw new Error('vpc-att denied');
        return { TransitGatewayVpcAttachments: opts.vpcAttachments ?? [] };
      case 'DescribeTransitGatewayRouteTablesCommand':
        return { TransitGatewayRouteTables: opts.routeTables ?? [] };
      case 'SearchTransitGatewayRoutesCommand':
        return { Routes: opts.routes ?? [], AdditionalRoutesAvailable: opts.additionalRoutes ?? false };
      default:
        throw new Error(`unexpected command ${c.constructor.name}`);
    }
  });
}

describe('tgwDetails (gap L168)', () => {
  it('merges VPC-attachment options into attachment rows; non-VPC rows keep options null', async () => {
    mockRegion({
      attachments: [
        { TransitGatewayAttachmentId: 'tgw-attach-vpc', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-1', State: 'available', Association: { TransitGatewayRouteTableId: 'tgw-rtb-1' } },
        { TransitGatewayAttachmentId: 'tgw-attach-vpn', TransitGatewayId: 'tgw-1', ResourceType: 'vpn', ResourceId: 'vpn-1', State: 'available' },
      ],
      vpcAttachments: [
        { TransitGatewayAttachmentId: 'tgw-attach-vpc', Options: { DnsSupport: 'enable', Ipv6Support: 'disable', ApplianceModeSupport: 'disable' } },
      ],
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    const vpc = d.attachments.find((a) => a.id === 'tgw-attach-vpc');
    const vpn = d.attachments.find((a) => a.id === 'tgw-attach-vpn');
    expect(vpc?.options).toEqual({ dnsSupport: 'enable', ipv6Support: 'disable', applianceModeSupport: 'disable' });
    expect(vpn?.options).toBeNull(); // the API exposes options per attachment TYPE
  });

  it('a failed VPC-attachment describe degrades to null options WITHOUT failing the region — and DISCLOSES it', async () => {
    mockRegion({
      attachments: [
        { TransitGatewayAttachmentId: 'tgw-attach-vpc', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-1', State: 'available' },
      ],
      failVpcAttachments: true,
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(d.attachments).toHaveLength(1); // attachments/routes still render
    expect(d.attachments[0].options).toBeNull();
    expect(d.degradedRegions ?? []).toEqual([]); // options degrade is NOT a region degrade
    // …but it IS disclosed: a denied options describe must never be conflated with
    // "not a VPC attachment" (the honest-degrade contract this file established)
    expect(d.optionsDegradedRegions).toEqual(['ap-northeast-2']);
  });

  it('a successful options describe reports NO options degradation', async () => {
    mockRegion({ attachments: [], vpcAttachments: [] });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(d.optionsDegradedRegions ?? []).toEqual([]);
  });

  it('follows NextToken on the VPC-attachment describe (a row past page 1 must not read —)', async () => {
    let call = 0;
    ec2Send.mockImplementation(async (cmd: unknown) => {
      const c = cmd as Cmd;
      switch (c.constructor.name) {
        case 'DescribeTransitGatewayAttachmentsCommand':
          return { TransitGatewayAttachments: [
            { TransitGatewayAttachmentId: 'att-2', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-2', State: 'available' },
          ] };
        case 'DescribeTransitGatewayVpcAttachmentsCommand': {
          call += 1;
          if (call === 1) {
            expect((c.input as { NextToken?: string }).NextToken).toBeUndefined();
            return { TransitGatewayVpcAttachments: [
              { TransitGatewayAttachmentId: 'att-1', Options: { DnsSupport: 'enable', Ipv6Support: 'disable', ApplianceModeSupport: 'disable' } },
            ], NextToken: 't2' };
          }
          expect((c.input as { NextToken?: string }).NextToken).toBe('t2');
          return { TransitGatewayVpcAttachments: [
            { TransitGatewayAttachmentId: 'att-2', Options: { DnsSupport: 'disable', Ipv6Support: 'disable', ApplianceModeSupport: 'enable' } },
          ] };
        }
        case 'DescribeTransitGatewayRouteTablesCommand':
          return { TransitGatewayRouteTables: [] };
        default:
          throw new Error('unexpected');
      }
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(call).toBe(2);
    expect(d.attachments[0].options).toEqual({ dnsSupport: 'disable', ipv6Support: 'disable', applianceModeSupport: 'enable' });
  });

  it('groups by owning region (a TGW in another region is queried with that region client)', async () => {
    mockRegion({ attachments: [], routeTables: [] });
    const { tgwDetails } = await import('./tgw');
    await tgwDetails([{ id: 'tgw-a' }, { id: 'tgw-b', region: 'us-west-2' }]);
    const regions = new Set(ec2Send.mock.calls.map(([, r]) => r));
    expect(regions).toEqual(new Set(['ap-northeast-2', 'us-west-2']));
  });

  it('a whole-region failure reports degradedRegions (missing, not empty)', async () => {
    mockRegion({ attachments: [], failRegion: 'us-west-2' });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-b', region: 'us-west-2' }]);
    expect(d.attachments).toEqual([]);
    expect(d.degradedRegions).toEqual(['us-west-2']);
  });

  it('route truncation flag survives (SearchTransitGatewayRoutes cap disclosed)', async () => {
    mockRegion({
      routeTables: [{ TransitGatewayRouteTableId: 'tgw-rtb-1', TransitGatewayId: 'tgw-1', State: 'available' }],
      routes: [{ DestinationCidrBlock: '10.0.0.0/8', Type: 'propagated', State: 'active', TransitGatewayAttachments: [{ ResourceId: 'vpc-1', ResourceType: 'vpc' }] }],
      additionalRoutes: true,
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(d.routeTables[0].truncated).toBe(true);
    expect(d.routeTables[0].routes[0]).toEqual({ cidr: '10.0.0.0/8', type: 'propagated', state: 'active', resourceId: 'vpc-1', resourceType: 'vpc' });
  });
});

describe('IAM wiring guard (the "new SDK call, forgotten IAM action" class)', () => {
  it('every TGW describe this module issues is granted in workload.tf', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const tf = readFileSync(
      join(__dirname, '..', '..', 'terraform', 'v2', 'foundation', 'workload.tf'), 'utf8',
    );
    for (const action of [
      'ec2:DescribeTransitGatewayAttachments',
      'ec2:DescribeTransitGatewayVpcAttachments',
      'ec2:DescribeTransitGatewayRouteTables',
      'ec2:SearchTransitGatewayRoutes',
    ]) {
      expect(tf, `${action} missing from the web task role`).toContain(`"${action}"`);
    }
  });
});
