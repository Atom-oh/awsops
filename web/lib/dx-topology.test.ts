import { describe, it, expect } from 'vitest';
import { buildDxTopology, assessResiliency, layoutDxTopology } from './dx-topology';
import type { DxConnectionRow, DxVifRow, DxGatewayRow } from './dx';

const conn = (o: Partial<DxConnectionRow>): DxConnectionRow => ({
  id: 'dxcon-1', name: 'c1', state: 'available', region: 'ap-northeast-2', location: 'SEL1',
  bandwidth: '1Gbps', bandwidthBps: 1e9, vlan: null, partnerName: null, awsDevice: null,
  jumboFrameCapable: false, macSecCapable: false, encryptionMode: null, portEncryptionStatus: null,
  hasLogicalRedundancy: null, lagId: null, vifCount: 0, stateMetricMin: 1, down: false, ...o,
});
const vif = (o: Partial<DxVifRow>): DxVifRow => ({
  id: 'dxvif-1', name: 'v1', type: 'private', state: 'available', region: 'ap-northeast-2',
  connectionId: 'dxcon-1', vlan: 100, mtu: 1500, jumboFrameCapable: false,
  asn: 65000, amazonSideAsn: 64512, addressFamily: 'ipv4', amazonAddress: null, customerAddress: null,
  attachedTo: null, attachmentType: null, siteLinkEnabled: false,
  bgpPeers: [], bgpPeersUp: 1, bgpPeersTotal: 1,
  bpsIngress: null, bpsEgress: null, peakBpsIngress: null, peakBpsEgress: null,
  ppsIngress: null, ppsEgress: null, peakUtilizationPct: null, bgpStatusMin: 1,
  prefixesAccepted: null, prefixesAdvertised: null, routes: [], routesTruncated: false,
  routesAvailable: true, down: false, ...o,
});
const gw = (o: Partial<DxGatewayRow>): DxGatewayRow => ({
  id: 'dxgw-1', name: 'gw1', state: 'available', amazonSideAsn: 64512, ownerAccount: '1',
  associations: [], vifCount: 0, unassociated: false, ...o,
});

describe('buildDxTopology', () => {
  it('계층 그래프: 온프레미스→로케이션→커넥션→VIF→DXGW→TGW, association 상태·cidr 라벨', () => {
    const g = buildDxTopology({
      connections: [conn({})],
      vifs: [vif({ attachedTo: 'dxgw-1', attachmentType: 'dx-gateway' })],
      gateways: [gw({ associations: [{ id: 'tgw-1', type: 'transitGateway', state: 'associated', region: 'ap-northeast-2', cidrs: ['10.0.0.0/8'] }] })],
    });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['onprem', 'loc|SEL1', 'dxcon-1', 'dxvif-1', 'dxgw-1', 'tgw-1']));
    expect(g.nodes.find((n) => n.id === 'tgw-1')!.kind).toBe('tgw');
    const es = g.edges.map((e) => `${e.source}→${e.target}`);
    expect(es).toEqual(expect.arrayContaining(['onprem→loc|SEL1', 'loc|SEL1→dxcon-1', 'dxcon-1→dxvif-1', 'dxvif-1→dxgw-1', 'dxgw-1→tgw-1']));
    expect(g.edges.find((e) => e.target === 'tgw-1')!.label).toBe('10.0.0.0/8');
  });

  it('LAG: 커넥션→LAG 엣지 + dxlag connectionId VIF는 LAG에 연결, 멤버 일부 다운 = warn', () => {
    const g = buildDxTopology({
      connections: [conn({ id: 'dxcon-1', lagId: 'dxlag-1' }), conn({ id: 'dxcon-2', lagId: 'dxlag-1', down: true })],
      vifs: [vif({ connectionId: 'dxlag-1' })],
      gateways: [],
    });
    const lag = g.nodes.find((n) => n.id === 'dxlag-1')!;
    expect(lag.kind).toBe('lag');
    expect(lag.state).toBe('warn');
    expect(lag.sub).toContain('1/2 up');
    expect(g.edges.some((e) => e.source === 'dxlag-1' && e.target === 'dxvif-1')).toBe(true);
  });

  it('public VIF→AWS 퍼블릭, 크로스 계정 DXGW 합성, 다운 상태 전파, 미연결 VIF는 엣지 없음', () => {
    const g = buildDxTopology({
      connections: [conn({ down: true })],
      vifs: [
        vif({ id: 'dxvif-pub', type: 'public' }),
        vif({ id: 'dxvif-x', attachedTo: 'dxgw-other', attachmentType: 'dx-gateway' }),
        vif({ id: 'dxvif-dangling' }),
      ],
      gateways: [],
    });
    expect(g.nodes.find((n) => n.id === 'awspub')).toBeTruthy();
    const synth = g.nodes.find((n) => n.id === 'dxgw-other')!;
    expect(synth.kind).toBe('dxgw');
    expect(g.nodes.find((n) => n.id === 'dxcon-1')!.state).toBe('down');
    expect(g.edges.some((e) => e.source === 'dxvif-dangling')).toBe(false);
    expect(layoutDxTopology(g).size).toBe(g.nodes.length);
  });

  it('리소스 0건 = 빈 그래프 (온프레미스 노드도 없음)', () => {
    expect(buildDxTopology({ connections: [], vifs: [], gateways: [] }).nodes).toEqual([]);
  });
});

describe('buildDxTopology — 리뷰 수정 회귀', () => {
  it('호스티드 VIF: 크로스 계정 부모 커넥션(dxcon-)/LAG(dxlag-)를 합성해 엣지 연결', () => {
    const g = buildDxTopology({
      connections: [],
      vifs: [
        vif({ id: 'dxvif-h1', connectionId: 'dxcon-hosted', attachedTo: 'dxgw-other', attachmentType: 'dx-gateway' }),
        vif({ id: 'dxvif-h2', connectionId: 'dxlag-hidden' }),
      ],
      gateways: [],
    });
    const parent = g.nodes.find((n) => n.id === 'dxcon-hosted')!;
    expect(parent.kind).toBe('connection');
    expect(parent.sub).toBe('(다른 계정)');
    expect(g.nodes.find((n) => n.id === 'dxlag-hidden')!.kind).toBe('lag');
    // 합성 LAG는 멤버 비가시 — '0/0 up'으로 덮이지 않음
    expect(g.nodes.find((n) => n.id === 'dxlag-hidden')!.sub).toBe('(다른 계정)');
    expect(g.edges.some((e) => e.source === 'dxcon-hosted' && e.target === 'dxvif-h1')).toBe(true);
    // 커넥션 0건이어도 VIF가 있으면 온프레미스 노드 존재
    expect(g.nodes.some((n) => n.id === 'onprem')).toBe(true);
  });

  it('onprem→로케이션 엣지는 로케이션당 1개 — 멤버 상태 집계 (일부 다운 = warn)', () => {
    const g = buildDxTopology({
      connections: [conn({}), conn({ id: 'dxcon-2', down: true })],
      vifs: [], gateways: [],
    });
    const trunk = g.edges.filter((e) => e.source === 'onprem' && e.target === 'loc|SEL1');
    expect(trunk).toHaveLength(1);
    expect(trunk[0].state).toBe('warn');
  });
});

describe('assessResiliency (DX SLA 티어 — sample-network-resilience-agent 규칙)', () => {
  it('none: 커넥션 0', () => {
    const r = assessResiliency({ connections: [], vifs: [], gateways: [] });
    expect(r.tier).toBe('none');
    expect(r.slaPct).toBeNull();
  });
  it('single 95%: 로케이션 1곳', () => {
    const r = assessResiliency({ connections: [conn({}), conn({ id: 'dxcon-2' })], vifs: [], gateways: [] });
    expect(r.tier).toBe('single');
    expect(r.slaPct).toBe('95%');
  });
  it('high 99.9%: 로케이션 2곳, 각 1개', () => {
    const r = assessResiliency({ connections: [conn({}), conn({ id: 'dxcon-2', location: 'SEL2' })], vifs: [], gateways: [] });
    expect(r.tier).toBe('high');
    expect(r.slaPct).toBe('99.9%');
  });
  it('maximum 99.99%: 2개 로케이션 × 각 2개 이상', () => {
    const r = assessResiliency({
      connections: [conn({}), conn({ id: 'c2' }), conn({ id: 'c3', location: 'SEL2' }), conn({ id: 'c4', location: 'SEL2' })],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('maximum');
    expect(r.slaPct).toBe('99.99%');
    expect(r.dualConnLocations).toBe(2);
  });
  it('deleted/rejected/개통 전 커넥션은 티어 산정에서 제외 (아키텍처 부풀림 방지)', () => {
    const r = assessResiliency({
      connections: [conn({}), conn({ id: 'c2', location: 'SEL2', state: 'deleted', down: true })],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('single'); // deleted 로케이션은 계상 안 함
    expect(r.locations).toBe(1);
    const r2 = assessResiliency({
      connections: [conn({}), conn({ id: 'c2', location: 'SEL2', state: 'ordering' })],
      vifs: [], gateways: [],
    });
    expect(r2.tier).toBe('single'); // 개통 전(ordering)도 제외
  });

  it('이중화는 로케이션당 고유 디바이스 기준 — 같은 디바이스 커넥션 2개는 이중화 아님', () => {
    const r = assessResiliency({
      connections: [
        conn({ id: 'c1', awsDevice: 'devA' }), conn({ id: 'c2', awsDevice: 'devA' }),
        conn({ id: 'c3', location: 'SEL2', awsDevice: 'devB' }), conn({ id: 'c4', location: 'SEL2', awsDevice: 'devC' }),
      ],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('high'); // SEL1은 디바이스 1개뿐 → maximum 불충족
    expect(r.dualConnLocations).toBe(1);
  });

  it('호스티드(파트너) 커넥션 수를 노출 — SLA 적용 제외 고지용', () => {
    const r = assessResiliency({
      connections: [conn({ partnerName: 'SomePartner' }), conn({ id: 'c2', location: 'SEL2' })],
      vifs: [], gateways: [],
    });
    expect(r.hostedConnections).toBe(1);
  });

  it('체크: 다운 커넥션·미연결 DXGW·미연결 VIF가 실패로 표시', () => {
    const r = assessResiliency({
      connections: [conn({ down: true })],
      vifs: [vif({ id: 'v-dangling' })],
      gateways: [gw({ unassociated: true })],
    });
    const by = (label: string) => r.checks.find((c) => c.label.includes(label))!;
    expect(by('모든 커넥션').ok).toBe(false);
    expect(by('미연결 DX Gateway').ok).toBe(false);
    expect(by('미연결 VIF').ok).toBe(false);
    expect(by('모든 VIF').ok).toBe(true);
  });
});
