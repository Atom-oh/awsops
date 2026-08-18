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
        queries.set(id, { group: cmd.input.logGroupName as string, query: cmd.input.queryString as string });
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
        if (query.includes('by sid, sig, act')) return [
          { sid: '5', sig: 'block outbound telnet', act: 'blocked', cnt: 7 },
          { sid: '9', sig: 'http watch', act: 'allowed', cnt: 3 },
        ];
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
    // 룰 히트 카운트 (sid+sig+action) — 2026-08 신기능과 동일한 Alert 로그 집계
    expect(a.alert!.ruleHits).toEqual([
      { sid: '5', signature: 'block outbound telnet', action: 'blocked', hits: 7 },
      { sid: '9', signature: 'http watch', action: 'allowed', hits: 3 },
    ]);
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
