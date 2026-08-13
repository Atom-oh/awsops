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
  // 실제 컬럼은 data(JSONB) — 쿼리가 `data AS detail`로 별칭하므로 결과 행도 detail 키로
  // 온다(리뷰 MAJOR 회귀 방지: 이전엔 존재하지 않는 row 컬럼을 mock이 그대로 흉내 내
  // 매 호출 실패하던 프로덕션 버그를 테스트가 가렸다).
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('DISTINCT region')
      ? { rows: [] }
      : { rows: [{ resource_id: 'vpc-1', detail: { name: 'mgmt-vpc', cidr_block: '10.254.0.0/16' } }] });
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

  it('부착 ENI 0 SG → 증거 없음(hits=null)으로 정직 처리, idle 확정 금지', async () => {
    mockDb();
    mockEc2();
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-stale', 3600);
    expect(h.source).toBe('none');
    expect(h.note).toBe('no_eni');
    // 리뷰 MAJOR 수정: ENI가 없어 트래픽 증거 자체가 없는데 hits=0(확정 idle)로 세면
    // "매칭 없음이 확인됨"과 "확인할 방법이 없음"을 혼동한다 — null(확인 불가)로 강등.
    expect(h.ruleHits.every((r) => r.hits === null)).toBe(true);
    expect(h.idleIngressRules).toBe(0);
  });

  it('Flow Logs 있지만 기간 내 레코드 0건 → 증거 없음(hits=null), idle 확정 금지', async () => {
    mockDb();
    mockEc2({ flowLogs: [{ ResourceId: 'vpc-1', LogDestinationType: 'cloud-watch-logs', LogGroupName: '/vpc/flow' }] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'StartQueryCommand' ? { queryId: 'q1' } : { status: 'Complete', results: [] });
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-web', 86400);
    expect(h.source).toBe('flowlogs');
    expect(h.note).toBe('flow_no_records');
    // 레코드 0건은 "매칭 안 됨이 확인됨"이 아니다(커스텀 포맷이라 parse가 전부 실패해도
    // 똑같이 0건으로 보임) — 매칭 가능 룰도 null로 둔다.
    expect(h.ruleHits.every((r) => r.hits === null)).toBe(true);
    expect(h.idleIngressRules).toBe(0);
  });

  it('Insights 상위 200건 캡에 물리면 hits=0 룰만 null(확인 불가)로 강등 — 실제 매칭(hits>0)은 유지', async () => {
    mockDb();
    mockEc2({ flowLogs: [{ ResourceId: 'vpc-1', LogDestinationType: 'cloud-watch-logs', LogGroupName: '/vpc/flow' }] });
    // 정확히 200건 반환 — limit 200에 물렸다는 신호. 그중 1건만 https(443) 룰과 매칭.
    const rows = Array.from({ length: 200 }, (_, i) => [
      { field: 'srcaddr', value: i === 0 ? '1.2.3.4' : `10.0.0.${i % 250}` },
      { field: 'dstaddr', value: '10.254.1.10' },
      { field: 'dstport', value: i === 0 ? '443' : '9999' },
      { field: 'protocol', value: '6' },
      { field: 'action', value: 'ACCEPT' },
      { field: 'cnt', value: '1' },
      { field: 'bytes', value: '10' },
    ]);
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'StartQueryCommand' ? { queryId: 'q1' } : { status: 'Complete', results: rows });
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-web', 86400);
    expect(h.source).toBe('flowlogs');
    expect(h.note).toBe('flow_capped');
    const https = h.ruleHits.find((r) => r.peerKind === 'internet' && r.portRange === '443')!;
    expect(https.hits).toBe(1); // 실제로 관측된 매칭은 신뢰 유지
    const internal = h.ruleHits.find((r) => r.portRange === '8080-8081')!;
    expect(internal.hits).toBeNull(); // 매칭 0건 — 캡 때문일 수 있으니 확인 불가로 강등
    expect(h.idleIngressRules).toBe(0); // null로 강등된 룰은 idle 카운트에서 제외
  });

  it('TrafficType=REJECT 전용 flow log는 룰-히트 소스로 채택하지 않고 NFM 폴백', async () => {
    mockDb();
    // REJECT 전용 flow log는 ACCEPT 레코드가 구조적으로 없어 모든 인바운드 룰이
    // 거짓 idle로 보인다(리뷰 MAJOR) — 애초에 룰-히트 소스로 쓰지 않고 NFM으로 폴백.
    mockEc2({ flowLogs: [{ ResourceId: 'vpc-1', LogDestinationType: 'cloud-watch-logs', LogGroupName: '/vpc/flow', TrafficType: 'REJECT' }] });
    mockNfmStatus.mockResolvedValue({ monitors: [{ name: 'nfm-vpc-all', status: 'ACTIVE', cluster: null }], scopeCount: 1 });
    mockNfmTop.mockResolvedValue({ rows: [], unit: 'Bytes', tookMs: 1 });
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-web', 86400);
    expect(h.source).toBe('nfm');
    expect(logsSend).not.toHaveBeenCalled(); // Insights를 아예 시도하지 않음
  });
});

describe('sgAnalysis — degrade + default SG', () => {
  it('리전 조회 실패 시 degradedRegions에 노출 (조용히 0건으로 보이면 안 됨)', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      sql.includes('DISTINCT region') ? { rows: [{ region: 'us-west-2' }] } : { rows: [] });
    ec2Send.mockImplementation(async (cmd: Cmd, region: string) => {
      if (region === 'us-west-2') throw new Error('boom us-west-2');
      switch (cmd.constructor.name) {
        case 'DescribeSecurityGroupsCommand': return { SecurityGroups: SGS };
        case 'DescribeNetworkInterfacesCommand': return { NetworkInterfaces: ENIS };
        case 'DescribeManagedPrefixListsCommand': return { PrefixLists: [] };
        case 'DescribeFlowLogsCommand': return { FlowLogs: [] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    const { sgAnalysis } = await import('./sg-analysis');
    const a = await sgAnalysis();
    expect(a.rows.length).toBe(3); // ap-northeast-2는 정상 로드
    expect(a.degradedRegions).toEqual(['us-west-2']);
  });

  it('default SG는 unused(정리 후보)로 세지 않음 — AWS가 삭제를 막아 상시 오탐이었음', async () => {
    mockDb();
    ec2Send.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'DescribeSecurityGroupsCommand':
          return { SecurityGroups: [{ GroupId: 'sg-default', GroupName: 'default', Description: 'default VPC security group', VpcId: 'vpc-1', IpPermissions: [], IpPermissionsEgress: [] }] };
        case 'DescribeNetworkInterfacesCommand': return { NetworkInterfaces: [] };
        case 'DescribeManagedPrefixListsCommand': return { PrefixLists: [] };
        case 'DescribeFlowLogsCommand': return { FlowLogs: [] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    const { sgAnalysis } = await import('./sg-analysis');
    const a = await sgAnalysis();
    const row = a.rows.find((r) => r.id === 'sg-default')!;
    expect(row.isDefault).toBe(true);
    expect(row.unused).toBe(false); // 부착·참조 모두 0이지만 default라 정리 후보 아님
    expect(a.totals.unused).toBe(0);
  });
});

describe('sgHits — 구조적 매칭 불가 케이스 수정 (리뷰 MAJOR 라운드2)', () => {
  function mockCustomSg(sg: Record<string, unknown>, enis: Record<string, unknown>[], flowLogs: unknown[] = []) {
    ec2Send.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'DescribeSecurityGroupsCommand': return { SecurityGroups: [sg] };
        case 'DescribeNetworkInterfacesCommand': return { NetworkInterfaces: enis };
        case 'DescribeManagedPrefixListsCommand': return { PrefixLists: [] };
        case 'DescribeFlowLogsCommand': return { FlowLogs: flowLogs };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
  }
  function mockFlowRows(rows: Record<string, string>[]) {
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'StartQueryCommand'
        ? { queryId: 'q' }
        : { status: 'Complete', results: rows.map((r) => Object.entries(r).map(([field, value]) => ({ field, value }))) });
  }

  it('자기 참조(self-reference) 룰: intra-SG 트래픽(src·dst 모두 자기 IP)도 매칭 — 이전엔 구조적으로 항상 idle이었음', async () => {
    mockDb();
    mockCustomSg(
      { GroupId: 'sg-self', GroupName: 'self-sg', VpcId: 'vpc-1', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: 'sg-self' }] }], IpPermissionsEgress: [] },
      [
        { NetworkInterfaceId: 'eni-a', InterfaceType: 'interface', Groups: [{ GroupId: 'sg-self' }], VpcId: 'vpc-1', PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.1' }] },
        { NetworkInterfaceId: 'eni-b', InterfaceType: 'interface', Groups: [{ GroupId: 'sg-self' }], VpcId: 'vpc-1', PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.2' }] },
      ],
      [{ ResourceId: 'vpc-1', LogDestinationType: 'cloud-watch-logs', LogGroupName: '/vpc/flow' }],
    );
    mockFlowRows([{ srcaddr: '10.0.0.1', dstaddr: '10.0.0.2', dstport: '5432', protocol: '6', action: 'ACCEPT', cnt: '42', bytes: '1000' }]);
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-self', 3600);
    expect(h.ruleHits[0].hits).toBe(42);
  });

  it('ICMP 룰: FromPort/ToPort는 type/code라 flow log dstport(항상 0)와 비교 불가 — hits=null', async () => {
    mockDb();
    mockCustomSg(
      { GroupId: 'sg-icmp', GroupName: 'icmp-sg', VpcId: 'vpc-1', IpPermissions: [{ IpProtocol: '1', FromPort: 8, ToPort: -1, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }], IpPermissionsEgress: [] },
      [{ NetworkInterfaceId: 'eni-i', InterfaceType: 'interface', Groups: [{ GroupId: 'sg-icmp' }], VpcId: 'vpc-1', PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.5' }] }],
      [{ ResourceId: 'vpc-1', LogDestinationType: 'cloud-watch-logs', LogGroupName: '/vpc/flow' }],
    );
    // ICMP echo request 인바운드 — flow log의 dstport는 항상 '0'.
    mockFlowRows([{ srcaddr: '1.2.3.4', dstaddr: '10.0.0.5', dstport: '0', protocol: '1', action: 'ACCEPT', cnt: '5', bytes: '500' }]);
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-icmp', 3600);
    expect(h.ruleHits[0].hits).toBeNull();
    expect(h.idleIngressRules).toBe(0);
  });

  it('IPv6 ::/0 룰: ENI의 IPv6 주소를 ownIps에 수집해야 매칭 가능 (이전엔 IPv4만 수집해 항상 idle)', async () => {
    mockDb();
    mockCustomSg(
      { GroupId: 'sg-v6', GroupName: 'v6-sg', VpcId: 'vpc-1', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Ipv6Ranges: [{ CidrIpv6: '::/0' }] }], IpPermissionsEgress: [] },
      [{ NetworkInterfaceId: 'eni-6', InterfaceType: 'interface', Groups: [{ GroupId: 'sg-v6' }], VpcId: 'vpc-1', PrivateIpAddresses: [], Ipv6Addresses: [{ Ipv6Address: '2001:db8::1' }] }],
      [{ ResourceId: 'vpc-1', LogDestinationType: 'cloud-watch-logs', LogGroupName: '/vpc/flow' }],
    );
    mockFlowRows([{ srcaddr: '2001:db8::abcd', dstaddr: '2001:db8::1', dstport: '443', protocol: '6', action: 'ACCEPT', cnt: '9', bytes: '900' }]);
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-v6', 3600);
    expect(h.ruleHits[0].hits).toBe(9);
  });

  it('NFM 폴백은 홈 리전이 아닌 SG에는 시도하지 않음 — 클라이언트가 리전 고정이라 엉뚱한 리전 데이터를 붙일 위험', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      sql.includes('DISTINCT region') ? { rows: [{ region: 'us-west-2' }] } : { rows: [] });
    ec2Send.mockImplementation(async (cmd: Cmd, region: string) => {
      if (region === 'us-west-2') {
        switch (cmd.constructor.name) {
          case 'DescribeSecurityGroupsCommand':
            return { SecurityGroups: [{ GroupId: 'sg-remote', GroupName: 'remote-sg', VpcId: 'vpc-remote', IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }], IpPermissionsEgress: [] }] };
          case 'DescribeNetworkInterfacesCommand':
            return { NetworkInterfaces: [{ NetworkInterfaceId: 'eni-r', InterfaceType: 'interface', Groups: [{ GroupId: 'sg-remote' }], VpcId: 'vpc-remote', PrivateIpAddresses: [{ PrivateIpAddress: '10.1.1.1' }] }] };
          case 'DescribeManagedPrefixListsCommand': return { PrefixLists: [] };
          case 'DescribeFlowLogsCommand': return { FlowLogs: [] };
          default: throw new Error(`unexpected ${cmd.constructor.name}`);
        }
      }
      switch (cmd.constructor.name) {
        case 'DescribeSecurityGroupsCommand': return { SecurityGroups: [] };
        case 'DescribeNetworkInterfacesCommand': return { NetworkInterfaces: [] };
        case 'DescribeManagedPrefixListsCommand': return { PrefixLists: [] };
        case 'DescribeFlowLogsCommand': return { FlowLogs: [] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    mockNfmStatus.mockResolvedValue({ monitors: [{ name: 'nfm-home', status: 'ACTIVE', cluster: null }], scopeCount: 1 });
    const { sgHits } = await import('./sg-analysis');
    const h = await sgHits('sg-remote', 3600);
    expect(h.source).toBe('none');
    expect(h.note).toBe('no_source');
    expect(mockNfmStatus).not.toHaveBeenCalled();
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
