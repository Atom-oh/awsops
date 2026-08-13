import { describe, it, expect, vi, beforeEach } from 'vitest';

// REGION은 모듈 로드 시점에 읽으므로 import 전에 고정 (테스트 결정성)
process.env.AWS_REGION = 'ap-northeast-2';

const ec2Send = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return ec2Send(cmd, this.cfg.region); }
  },
  DescribeSecurityGroupsCommand: class { constructor(public input: unknown) {} },
  DescribeNetworkInterfacesCommand: class { constructor(public input: unknown) {} },
  DescribeFlowLogsCommand: class { constructor(public input: unknown) {} },
  DescribeManagedPrefixListsCommand: class { constructor(public input: unknown) {} },
}));

const logsSend = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return logsSend(cmd, this.cfg.region); }
  },
  StartQueryCommand: class { constructor(public input: unknown) {} },
  GetQueryResultsCommand: class { constructor(public input: unknown) {} },
  StopQueryCommand: class { constructor(public input: unknown) {} },
}));

const mockNfmStatus = vi.fn();
const mockNfmTop = vi.fn();
vi.mock('./nfm', () => ({
  nfmStatus: () => mockNfmStatus(),
  nfmTopContributors: (...a: unknown[]) => mockNfmTop(...a),
  NFM_MAX_RANGE_SEC: 3600,
  NFM_CATEGORIES: ['INTRA_AZ', 'INTER_AZ', 'INTER_VPC', 'INTER_REGION', 'AMAZON_S3', 'AMAZON_DYNAMODB', 'UNCLASSIFIED'],
}));

const mockQuery = vi.fn();
vi.mock('./db', () => ({ getPool: () => ({ query: mockQuery }) }));

beforeEach(async () => {
  ec2Send.mockReset();
  logsSend.mockReset();
  mockNfmStatus.mockReset();
  mockNfmTop.mockReset();
  mockQuery.mockReset();
  const { _resetSgCacheForTests } = await import('./sg-analysis');
  _resetSgCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function mockDb() {
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('DISTINCT region')
      ? { rows: [] }
      : { rows: [{ resource_id: 'vpc-1', row: { name: 'mgmt-vpc', cidr_block: '10.254.0.0/16' } }] });
}

// 실측 형태 SG 3개: web(부착+개방), db(참조만), stale(미사용)
const SGS = [
  {
    GroupId: 'sg-web', GroupName: 'web-sg', Description: 'web tier', VpcId: 'vpc-1',
    IpPermissions: [
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'public https' }] },
      { IpProtocol: 'tcp', FromPort: 8080, ToPort: 8081, IpRanges: [{ CidrIp: '10.254.0.0/16', Description: 'vpc internal' }] },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, PrefixListIds: [{ PrefixListId: 'pl-123', Description: 'cloudfront' }] },
    ],
    IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
  },
  {
    GroupId: 'sg-db', GroupName: 'db-sg', Description: 'db tier', VpcId: 'vpc-1',
    IpPermissions: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: 'sg-web', Description: 'from web' }] }],
    IpPermissionsEgress: [],
  },
  {
    GroupId: 'sg-stale', GroupName: 'old-sg', Description: 'leftover', VpcId: 'vpc-1',
    IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
    IpPermissionsEgress: [],
  },
];
const ENIS = [
  {
    NetworkInterfaceId: 'eni-1', InterfaceType: 'interface', Description: 'ELB app/my-alb/abc',
    Groups: [{ GroupId: 'sg-web' }], VpcId: 'vpc-1',
    PrivateIpAddresses: [{ PrivateIpAddress: '10.254.1.10' }],
  },
  {
    NetworkInterfaceId: 'eni-2', InterfaceType: 'interface', Description: '',
    Groups: [{ GroupId: 'sg-web' }], VpcId: 'vpc-1', Attachment: { InstanceId: 'i-abc' },
    PrivateIpAddresses: [{ PrivateIpAddress: '10.254.1.11' }],
  },
];

function mockEc2(opts: { flowLogs?: unknown[] } = {}) {
  ec2Send.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeSecurityGroupsCommand': return { SecurityGroups: SGS };
      case 'DescribeNetworkInterfacesCommand': return { NetworkInterfaces: ENIS };
      case 'DescribeManagedPrefixListsCommand': return { PrefixLists: [] };
      case 'DescribeFlowLogsCommand': return { FlowLogs: opts.flowLogs ?? [] };
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
}

describe('sgAnalysis', () => {
  it('사용 유무: 부착·참조·미사용 3분류 + 개방 인바운드 집계', async () => {
    mockDb();
    mockEc2();
    const { sgAnalysis } = await import('./sg-analysis');
    const a = await sgAnalysis();

    // sg-db는 부착 0·피참조 0(참조를 '하는' 쪽) → 미사용, sg-stale도 미사용
    expect(a.totals).toMatchObject({ total: 3, attached: 1, unused: 2, referencedOnly: 0, openIngress: 2, enis: 2 });

    const web = a.rows.find((r) => r.id === 'sg-web')!;
    expect(web.eniCount).toBe(2);
    expect(web.attachedKinds).toEqual([{ kind: 'ALB', count: 1 }, { kind: 'EC2', count: 1 }]);
    expect(web.openIngress).toBe(1);
    expect(web.unused).toBe(false);

    const db = a.rows.find((r) => r.id === 'sg-db')!;
    expect(db.eniCount).toBe(0);
    expect(db.referencedBy).toEqual([]); // sg-db는 아무도 참조 안 함
    expect(db.unused).toBe(true);

    // sg-web은 sg-db 룰이 소스로 참조 → referencedBy에 이름 병기
    expect(web.referencedBy).toEqual(['sg-db (db-sg)']);
    const stale = a.rows.find((r) => r.id === 'sg-stale')!;
    expect(stale.unused).toBe(true);
  });

  it('소스/목적지 식별: 인터넷 전체·VPC 이름·SG 이름·설명 라벨', async () => {
    mockDb();
    mockEc2();
    const { sgAnalysis } = await import('./sg-analysis');
    const a = await sgAnalysis();

    const web = a.rows.find((r) => r.id === 'sg-web')!;
    const https = web.rules.find((r) => r.portRange === '443')!;
    expect(https.peerKind).toBe('internet');
    expect(https.peerLabel).toBe('0.0.0.0/0'); // 번역은 클라이언트(peerKind 기반) — 페이로드는 raw
    expect(https.open).toBe(true);
    expect(https.description).toBe('public https');

    const internal = web.rules.find((r) => r.portRange === '8080-8081')!;
    expect(internal.peerLabel).toBe('10.254.0.0/16 (mgmt-vpc)'); // 인벤토리 VPC CIDR 매칭

    const db = a.rows.find((r) => r.id === 'sg-db')!;
    const fromWeb = db.rules[0];
    expect(fromWeb.peerKind).toBe('sg');
    expect(fromWeb.peerLabel).toBe('sg-web (web-sg)'); // SG 이름 병기
  });

  it('참조 방향: sg-db 룰의 소스가 sg-web → sg-web이 피참조(referencedBy=sg-db)', async () => {
    mockDb();
    mockEc2();
    const { sgAnalysis } = await import('./sg-analysis');
    const a = await sgAnalysis();
    const refMap = Object.fromEntries(a.rows.map((r) => [r.id, r.referencedBy]));
    expect(refMap['sg-web']).toEqual(['sg-db (db-sg)']);
    expect(refMap['sg-db']).toEqual([]);
  });
});

describe('sgHits', () => {
  it('Flow Logs(CWL): 인바운드만 룰 매칭 — 아웃바운드/자기IP 제외, pl 룰은 n/a', async () => {
    mockDb();
    mockEc2({ flowLogs: [{ ResourceId: 'vpc-1', LogDestinationType: 'cloud-watch-logs', LogGroupName: '/vpc/flow' }] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') return { queryId: 'q1' };
      return {
        status: 'Complete',
        results: [
          // 인바운드 443 ACCEPT (외부 → SG IP) → https 룰 매칭
          [{ field: 'srcaddr', value: '1.2.3.4' }, { field: 'dstaddr', value: '10.254.1.10' }, { field: 'dstport', value: '443' }, { field: 'protocol', value: '6' }, { field: 'action', value: 'ACCEPT' }, { field: 'cnt', value: '120' }, { field: 'bytes', value: '9000' }],
          // 인바운드 8080 ACCEPT (VPC 내 외부 IP → SG IP) → 내부 CIDR 룰 매칭
          [{ field: 'srcaddr', value: '10.254.5.5' }, { field: 'dstaddr', value: '10.254.1.11' }, { field: 'dstport', value: '8080' }, { field: 'protocol', value: '6' }, { field: 'action', value: 'ACCEPT' }, { field: 'cnt', value: '5' }, { field: 'bytes', value: '500' }],
          // 아웃바운드 (자기 IP가 소스) — 인바운드 룰에 매칭·peer 표시 모두 금지
          [{ field: 'srcaddr', value: '10.254.1.11' }, { field: 'dstaddr', value: '8.8.8.8' }, { field: 'dstport', value: '443' }, { field: 'protocol', value: '6' }, { field: 'action', value: 'ACCEPT' }, { field: 'cnt', value: '999' }, { field: 'bytes', value: '99999' }],
          // 인바운드 REJECT → 룰 매칭 제외, peers엔 REJECT로 표시
          [{ field: 'srcaddr', value: '5.6.7.8' }, { field: 'dstaddr', value: '10.254.1.10' }, { field: 'dstport', value: '22' }, { field: 'protocol', value: '6' }, { field: 'action', value: 'REJECT' }, { field: 'cnt', value: '30' }, { field: 'bytes', value: '100' }],
        ],
      };
    });
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-web', 86400);

    expect(h.source).toBe('flowlogs');
    expect(h.note).toBeNull();
    const https = h.ruleHits.find((r) => r.peerKind === 'internet' && r.portRange === '443')!;
    expect(https.hits).toBe(120); // 아웃바운드 999는 미포함
    expect(https.bytes).toBe(9000);
    const internal = h.ruleHits.find((r) => r.portRange === '8080-8081')!;
    expect(internal.hits).toBe(5);
    // pl 룰은 구조적 매칭 불가 → n/a(null), idle로 세지 않음
    const pl = h.ruleHits.find((r) => r.peerKind === 'pl')!;
    expect(pl.hits).toBeNull();
    expect(h.idleIngressRules).toBe(0);
    // peers: 자기 IP 아웃바운드 제외, REJECT 표시
    expect(h.peers.map((p) => p.ip).sort()).toEqual(['1.2.3.4', '10.254.5.5', '5.6.7.8']);
    expect(h.peers.find((p) => p.ip === '5.6.7.8')!.action).toBe('REJECT');
  });

  it('Flow Logs 없으면 NFM 폴백 — 상대 식별 전용, 룰 히트는 전부 n/a(거짓 idle 억제)', async () => {
    mockDb();
    mockEc2();
    mockNfmStatus.mockResolvedValue({ monitors: [{ name: 'nfm-vpc-all', status: 'ACTIVE', cluster: null }], scopeCount: 1 });
    mockNfmTop.mockResolvedValue({
      rows: [
        {
          local: { ip: '10.254.1.11' }, remote: { ip: '10.254.9.9', instanceId: 'i-peer' },
          value: 777, unit: 'Bytes', category: 'INTRA_AZ', targetPort: 8080, traversed: [], traversedIds: [],
        },
        { local: { ip: '10.9.9.9' }, remote: { ip: '10.8.8.8' }, value: 1, unit: 'Bytes', category: 'INTRA_AZ', traversed: [], traversedIds: [] },
      ], unit: 'Bytes', tookMs: 1,
    });
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-web', 86400);

    expect(h.source).toBe('nfm');
    expect(h.note).toBe('nfm_peers_only');
    expect(h.rangeSec).toBe(3600); // 1h 상한
    // NFM은 양방향 집계라 룰 귀속 불가 — 전부 null, idle 0 (거짓 정리-후보 신호 방지)
    expect(h.ruleHits.every((r) => r.hits === null)).toBe(true);
    expect(h.idleIngressRules).toBe(0);
    // 7개 전 카테고리 조회 + peer dedupe (같은 mock 7회 → count 7 합산)
    expect(mockNfmTop).toHaveBeenCalledTimes(7);
    expect(h.peers).toHaveLength(1);
    expect(h.peers[0]).toMatchObject({ ip: '10.254.9.9', label: 'EC2: i-peer', count: 7, bytes: 777 * 7 });
  });

  it('부착 ENI 0 SG → 트래픽 없음 정직 처리', async () => {
    mockDb();
    mockEc2();
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-stale', 3600);
    expect(h.source).toBe('none');
    expect(h.note).toBe('no_eni');
    expect(h.idleIngressRules).toBe(1);
  });
});

describe('ipInCidr', () => {
  it('IPv4 CIDR 포함 판정', async () => {
    const { ipInCidr } = await import('./sg-analysis');
    expect(ipInCidr('10.254.1.10', '10.254.0.0/16')).toBe(true);
    expect(ipInCidr('10.255.1.10', '10.254.0.0/16')).toBe(false);
    expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
  });
});
