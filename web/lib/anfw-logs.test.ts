import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-northeast-2';

const logsSend = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return logsSend(cmd, this.cfg.region); }
  },
  StartQueryCommand: class { constructor(public input: unknown) {} },
  GetQueryResultsCommand: class { constructor(public input: unknown) {} },
  StopQueryCommand: class { constructor(public input: unknown) {} },
  DescribeLogGroupsCommand: class { constructor(public input: unknown) {} },
}));

const mockAnalysis = vi.fn();
vi.mock('./anfw', () => ({ anfwAnalysis: (r: number) => mockAnalysis(r) }));

beforeEach(async () => {
  logsSend.mockReset();
  mockAnalysis.mockReset();
  const { _resetAnfwLogsCacheForTests } = await import('./anfw-logs');
  _resetAnfwLogsCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const fw = (over: Record<string, unknown> = {}) => ({
  name: 'DMZVPC-nfw', region: 'ap-northeast-2', loggingKnown: true,
  alertLogging: 'CloudWatchLogs:/aws/network-firewall/DMZVPC/alert',
  flowLogging: 'CloudWatchLogs:/aws/network-firewall/DMZVPC/flow',
  ...over,
});

/** Insights 결과 행 생성 — [{field, value}] 형식. */
const row = (o: Record<string, string | number>) =>
  Object.entries(o).map(([field, value]) => ({ field, value: String(value) }));

/** 그룹×쿼리 문자열 매칭으로 결과 dispatch. */
function mockInsights(resultsFor: (group: string, query: string) => Record<string, string | number>[]) {
  const queries = new Map<string, { group: string; query: string }>();
  let n = 0;
  logsSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'StartQueryCommand': {
        const id = `q${n++}`;
        const groups = (cmd.input.logGroupNames as string[]) ?? [];
        queries.set(id, { group: groups[0] ?? '', query: cmd.input.queryString as string });
        return { queryId: id };
      }
      case 'GetQueryResultsCommand': {
        const q = queries.get(cmd.input.queryId as string)!;
        return { status: 'Complete', results: resultsFor(q.group, q.query).map(row) };
      }
      case 'DescribeLogGroupsCommand':
        return { logGroups: [] };
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
}

describe('anfwLogsAnalysis', () => {
  it('구성된 CWL 대상에서 alert/flow 집계 (스테이징 실측 형태)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw()] });
    mockInsights((group, query) => {
      if (group.endsWith('/alert')) {
        if (query.includes('by action')) return [{ action: 'blocked', cnt: 7 }, { action: 'allowed', cnt: 3 }];
        if (query.includes('by sid')) return [{ sid: '5', sig: 'block outbound telnet', cnt: 7 }];
        if (query.includes('by src')) return [{ src: '10.11.1.111', cnt: 8 }];
        if (query.includes('by dst')) return [{ dst: '10.12.2.34:23', cnt: 7 }];
        return [{ cnt: 10 }]; // totals
      }
      // flow 그룹
      if (query.includes('by src, dst')) return [{ src: '10.11.1.111', dst: '10.12.2.34', bytes: 12345, cnt: 4 }];
      if (query.includes('by proto')) return [{ proto: 'TCP', cnt: 9 }];
      return [{ cnt: 9, bytes: 20000 }]; // totals
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(86400);

    expect(a.targets).toHaveLength(2);
    expect(a.targets.every((t) => !t.discovered)).toBe(true);
    expect(a.unsupportedDestinations).toBe(0);
    expect(a.failed).toEqual([]);

    expect(a.alert!.totalAlerts).toBe(10);
    expect(a.alert!.byAction).toEqual([{ name: 'blocked', value: 7 }, { name: 'allowed', value: 3 }]);
    expect(a.alert!.topSignatures).toEqual([{ sid: '5', signature: 'block outbound telnet', value: 7 }]);
    expect(a.alert!.topSources[0]).toEqual({ name: '10.11.1.111', value: 8 });
    expect(a.alert!.topDests[0]).toEqual({ name: '10.12.2.34:23', value: 7 });

    expect(a.flow!.totalFlows).toBe(9);
    expect(a.flow!.totalBytes).toBe(20000);
    expect(a.flow!.talkersWindowSec).toBe(21600); // 24h 요청 → talker는 6h 창으로 제한
    expect(a.flow!.topTalkers[0]).toMatchObject({ src: '10.11.1.111', dst: '10.12.2.34', bytes: 12345, flows: 4 });
    expect(a.flow!.byProto).toEqual([{ name: 'TCP', value: 9 }]);
  });

  it('loggingKnown=false → 접두사 발견 폴백 (discovered=true, 이름으로 alert/flow 분류)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    const base = mockInsightsWithDiscovery();
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets.map((t) => [t.type, t.group, t.discovered])).toEqual([
      ['ALERT', '/aws/network-firewall/DMZVPC/alert', true],
      ['FLOW', '/aws/network-firewall/DMZVPC/flow', true],
    ]);
    expect(a.alert!.totalAlerts).toBe(base.alerts);
  });

  it('발견 폴백 DescribeLogGroups가 실패(스로틀/거부)하면 "발견된 로그 없음"과 구분해 failed에 표시 (리뷰 MAJOR)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeLogGroupsCommand') throw new Error('AccessDenied');
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // DescribeLoggingConfiguration이 이미 거부된 환경에서 이 폴백까지 실패해도 targets:[]
    // 자체는 "발견된 로그 없음"과 똑같이 보인다 — failed에 별도 키가 있어야 "확인 불가"와
    // "정말 없음"이 구분된다.
    expect(a.targets).toEqual([]);
    expect(a.failed).toContain('logDiscovery');
  });

  it('발견 폴백 DescribeLogGroups는 NextToken을 순회해 1페이지 너머의 로그 그룹도 찾는다', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'DescribeLogGroupsCommand':
          if (!cmd.input.nextToken) {
            return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alert' }], nextToken: 'page2' };
          }
          return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/flow' }] };
        case 'StartQueryCommand': return { queryId: 'q' };
        case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 1, bytes: 1 })] };
        default: return {};
      }
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets.map((t) => t.type).sort()).toEqual(['ALERT', 'FLOW']);
  });

  it('ALERT는 CWL, FLOW는 S3처럼 섞인 대상도 unsupported로 집계 (리뷰 MINOR: 이전엔 누락)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: 'S3:my-log-bucket' })] });
    mockInsights(() => [{ cnt: 3 }]);
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // ALERT 쪽은 여전히 CWL이라 분석은 정상 수행되지만, FLOW의 S3 leg는 고지 대상이어야 한다.
    expect(a.targets.map((t) => t.type)).toEqual(['ALERT']);
    expect(a.unsupportedDestinations).toBe(1);
    expect(a.alert).not.toBeNull();
  });

  it('S3/Firehose 대상만 있으면 unsupported 집계 + 분석 null (정직 고지)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ alertLogging: 'S3:my-log-bucket', flowLogging: 'KinesisDataFirehose:stream' })] });
    mockInsights(() => []);
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets).toEqual([]);
    expect(a.unsupportedDestinations).toBe(1);
    expect(a.alert).toBeNull();
    expect(a.flow).toBeNull();
  });

  it('그룹 쿼리 실패는 해당 키만 failed로 degrade', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        if (q.includes('by action')) throw new Error('boom');
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 5 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toEqual(['alertByAction']);
    expect(a.alert!.totalAlerts).toBe(5);
    expect(a.flow).toBeNull(); // FLOW 대상 없음
  });

  it('두 방화벽이 같은 로그 그룹을 공유하면 쿼리를 한 번만 실행 — 이중 집계 방지 (리뷰 MAJOR)', async () => {
    // 중앙 공용 alert 로그 그룹으로 로깅하는 방화벽 2개 — (region, type, group) 동일.
    mockAnalysis.mockResolvedValue({
      firewalls: [
        fw({ name: 'fw-a', flowLogging: null }),
        fw({ name: 'fw-b', flowLogging: null }), // fw()의 alertLogging 기본값과 동일한 그룹 재사용
      ],
    });
    mockInsights(() => [{ cnt: 10 }]); // totals — 그룹당 한 번만 실행되면 합계는 10 그대로
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // targets는 방화벽 단위로 2건 남아 있어도(어느 방화벽이 이 그룹을 쓰는지 표시 목적)
    // 실제 쿼리는 그룹당 1회만 — 중복 실행이었다면 같은 결과 행이 두 번 합산돼 20이 됐을 것.
    expect(a.targets).toHaveLength(2);
    expect(a.alert!.totalAlerts).toBe(10);
  });

  it('리전 중 하나라도 실패하면 다른 리전이 성공해도 failed로 표시 (all-regions 계약, 리뷰 MAJOR)', async () => {
    // 리뷰 MAJOR 수정으로 같은 리전의 그룹들은 이제 logGroupNames로 한 쿼리에 묶이므로,
    // 부분 실패를 검증하려면 그룹이 아니라 리전을 달리해야 한다(리전 = 실패 단위).
    mockAnalysis.mockResolvedValue({
      firewalls: [
        fw({ name: 'fw-a', flowLogging: null }), // ap-northeast-2 (기본)
        fw({ name: 'fw-b', flowLogging: null, region: 'us-east-1', alertLogging: 'CloudWatchLogs:/aws/network-firewall/other/alert' }),
      ],
    });
    logsSend.mockImplementation(async (cmd: Cmd, region: string) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        if (region === 'us-east-1') throw new Error('boom other region');
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 5 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // 이전 계약("하나라도 성공하면 ok")이었다면 실패한 리전의 누락된 트래픽이 조용히
    // 사라진 채 totals만 부분치로 조용히 보였을 것 — 지금은 실패가 있었다는 신호를 남긴다.
    expect(a.failed).toContain('alertTotals');
  });

  it('anfwAnalysis()의 degradedRegions가 있으면(방화벽 목록 자체 조회 실패) "로그 없음"과 구분해 failed에 표시 (리뷰 MAJOR)', async () => {
    // firewalls는 비어 있지만 degradedRegions엔 실패 리전이 있다 — 그 리전의 방화벽이
    // 어떤 대상으로 로깅하는지 원래 확인조차 못 한 것이지 "로깅 대상이 없음"이 아니다.
    mockAnalysis.mockResolvedValue({ firewalls: [], degradedRegions: ['us-west-2'] });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets).toEqual([]);
    expect(a.failed).toContain('firewallDiscovery');
  });

  it('리전별 top-N 쿼리는 표시 컷오프(10)보다 훨씬 큰 상한으로 오버페치 — 리전 간 병합 절단 축소 (리뷰 MAJOR)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw()] });
    let sigQuery = '';
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        if (q.includes('by sid, sig')) sigQuery = q;
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 1 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    await anfwLogsAnalysis(3600);
    expect(sigQuery).toContain('limit 100');
  });

  it('같은 리전의 여러 로그 그룹은 logGroupNames로 한 쿼리에 묶여 그룹별 limit이 진짜 전역 Top-N이 됨 (리뷰 MAJOR)', async () => {
    // 서로 다른 두 그룹(중복 제거 대상 아님, 같은 리전) — 이전엔 그룹별로 최대 10개까지
    // 잘라 병합해 11위 항목이 두 그룹 모두에서 통째로 사라질 수 있었다. 이제 한 쿼리로
    // 묶이므로 mock도 logGroupNames에 두 그룹이 모두 실려 있는지 검증한다.
    mockAnalysis.mockResolvedValue({
      firewalls: [
        fw({ name: 'fw-a', flowLogging: null }),
        fw({ name: 'fw-b', flowLogging: null, alertLogging: 'CloudWatchLogs:/aws/network-firewall/other/alert' }),
      ],
    });
    let seenGroups: string[] = [];
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const groups = cmd.input.logGroupNames as string[];
        if (groups.length > 1) seenGroups = groups;
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 5 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    await anfwLogsAnalysis(3600);
    expect(seenGroups.sort()).toEqual([
      '/aws/network-firewall/DMZVPC/alert',
      '/aws/network-firewall/other/alert',
    ]);
  });

  it('구성 조회 거부(loggingKnown=false) + 접두사 스캔이 예외 없이 0건 반환하면 "로그 없음 확정"이 아니라 logDiscoveryEmpty로 표시 (리뷰 MAJOR 라운드7)', async () => {
    // 접두사 스캔이 실패한 게 아니라(discoveryFailed=false) 정상 실행됐는데 관례 명명과
    // 일치하는 그룹이 하나도 없는 경우(커스텀 명명이면 흔함) — 여전히 "모름"이지 "없음"이
    // 확인된 게 아니다. 이전엔 이 경우 targets:[], failed:[]로 확정 all-clear처럼 보였다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand' ? { logGroups: [] } : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets).toEqual([]);
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2');
  });

  it('Insights 폴링은 anfwLogsAnalysis 진입 시점부터 계산된 공유 데드라인을 넘기면 중단(StopQuery)하고 failed로 표시 (리뷰 MAJOR 라운드7)', async () => {
    // anfwAnalysis()의 콜드 fan-out + 45s 폴링이 겹치면 60s 라우트 예산을 넘길 수 있다는
    // 것이 라운드7 MAJOR였다 — 데드라인이 anfwLogsAnalysis 호출 "시점"부터 공유돼야
    // 폴링이 스스로 멈춘다. Date.now를 조작해 "StartQuery 직후 이미 데드라인을 넘긴"
    // 상황을 시뮬레이션 — 폴링 루프가 한 번도 GetQueryResults를 완료로 못 보고 즉시
    // StopQuery로 빠져야 한다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    let stopped = false;
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'StartQueryCommand':
          now += 46_000; // 45s 예산을 이미 넘긴 상태로 진입
          return { queryId: 'q' };
        case 'GetQueryResultsCommand':
          return { status: 'Running' }; // 완료 신호가 없어도 데드라인 검사가 즉시 루프를 빠져나가야 함
        case 'StopQueryCommand':
          stopped = true;
          return {};
        default: return {};
      }
    });
    try {
      const { anfwLogsAnalysis } = await import('./anfw-logs');
      const a = await anfwLogsAnalysis(3600);
      expect(stopped).toBe(true);
      expect(a.failed).toContain('alertTotals');
    } finally {
      dateSpy.mockRestore();
    }
  });
});

/** 발견 폴백용 mock: DescribeLogGroups가 관례 이름 2개 반환 + 최소 Insights 응답. */
function mockInsightsWithDiscovery() {
  const alerts = 3;
  logsSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeLogGroupsCommand':
        return {
          logGroups: [
            { logGroupName: '/aws/network-firewall/DMZVPC/alert' },
            { logGroupName: '/aws/network-firewall/DMZVPC/flow' },
          ],
        };
      case 'StartQueryCommand': return { queryId: 'q' };
      case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: alerts, bytes: 1 })] };
      default: return {};
    }
  });
  return { alerts };
}
