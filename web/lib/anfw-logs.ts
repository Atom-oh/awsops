import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { anfwAnalysis } from './anfw';

// Network Firewall Alert/Flow 로그 분석 (owner 가이드 2계층): 방화벽 로깅 구성의
// **CloudWatch Logs 대상만** Logs Insights로 집계한다 (S3/Firehose 대상은 Insights 불가 —
// dns-logs와 동일 제약, 화면에 정직 고지). 로그는 Suricata EVE JSON — 중첩 필드는
// `event.alert.signature_id` 도트 표기로 접근.
// 함정: 스테이징 태스크 롤은 DescribeLoggingConfiguration이 SCP류로 거부(loggingKnown=false)
// → 이때는 `/aws/network-firewall/` 접두사 DescribeLogGroups로 **휴리스틱 발견** 폴백
// (이름에 alert/flow 포함 여부로 분류, discovered=true로 표시).

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const logsClients = new Map<string, CloudWatchLogsClient>();
const logs = (r: string) => {
  let c = logsClients.get(r);
  if (!c) { c = new CloudWatchLogsClient({ region: r }); logsClients.set(r, c); }
  return c;
};

const TTL_MS = 4 * 60_000; // Insights는 스캔 GB 과금 — 캐시 필수
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetAnfwLogsCacheForTests() { cache.clear(); inflight.clear(); logsClients.clear(); }

type Row = Record<string, string>;

async function runInsights(region: string, group: string, query: string, rangeSec: number): Promise<Row[]> {
  const end = Math.floor(Date.now() / 1000);
  const { queryId } = await logs(region).send(new StartQueryCommand({
    logGroupName: group, queryString: query, startTime: end - rangeSec, endTime: end, limit: 1000,
  }));
  if (!queryId) return [];
  // 폴링 상한 45s — flow 로그는 대용량(실측 24h 566만 행)이라 30s로는 group-by가 미완료.
  for (let i = 0; i < 45; i++) {
    const res = await logs(region).send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') {
      return (res.results ?? []).map((row) =>
        Object.fromEntries(row.filter((f) => f.field && f.field !== '@ptr').map((f) => [f.field as string, f.value ?? ''])));
    }
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
      throw new Error(`Insights query ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await logs(region).send(new StopQueryCommand({ queryId })).catch(() => {});
  throw new Error('Insights query poll cap reached');
}

export interface AnfwLogTarget {
  firewall: string; region: string; type: 'ALERT' | 'FLOW'; group: string;
  /** true = 로깅 구성 조회 불가로 접두사 휴리스틱 발견 (구성 확인 아님). */
  discovered: boolean;
}

export interface AnfwAlertAnalytics {
  totalAlerts: number;
  byAction: { name: string; value: number }[];
  topSignatures: { sid: string; signature: string; value: number }[];
  topSources: { name: string; value: number }[];
  topDests: { name: string; value: number }[];
}

export interface AnfwFlowAnalytics {
  totalFlows: number; totalBytes: number;
  /** (src, dst) 호스트쌍 기준 — dest_port는 유동 포트라 group 카디널리티가 플로우 수와 같아져 시간 초과(실측). */
  topTalkers: { src: string; dst: string; bytes: number; flows: number }[];
  /** Top talker 집계 창(초) — 플로우 볼륨 과다로 요청 범위보다 좁을 수 있음 (rangeSec와 다르면 UI 고지). */
  talkersWindowSec: number;
  byProto: { name: string; value: number }[];
}

export interface AnfwLogsAnalysis {
  targets: AnfwLogTarget[];
  /** CloudWatch Logs 외 대상(S3/Firehose)만 있는 방화벽 수 — Insights 분석 불가 고지용. */
  unsupportedDestinations: number;
  alert: AnfwAlertAnalytics | null;
  flow: AnfwFlowAnalytics | null;
  /** 부분 실패한 분석 키 (해당 패널만 비움). */
  failed: string[];
  rangeSec: number;
}

const num = (s: string | undefined): number => (s != null && s !== '' ? Number(s) || 0 : 0);

/** 로깅 구성(알면 정확) 또는 접두사 발견(모르면 휴리스틱)으로 CWL 대상 도출. */
async function resolveTargets(rangeSec: number): Promise<{ targets: AnfwLogTarget[]; unsupported: number; discoveryFailed: boolean }> {
  const a = await anfwAnalysis(rangeSec);
  const targets: AnfwLogTarget[] = [];
  let unsupported = 0;
  const discoverRegions = new Set<string>();
  for (const f of a.firewalls) {
    if (!f.loggingKnown) { discoverRegions.add(f.region); continue; }
    // 리뷰 MINOR: ALERT→CWL + FLOW→S3처럼 섞인 방화벽은 anyCwl=true라 unsupported에서
    // 누락됐다 — S3 쪽 로그는 여전히 Insights 분석 불가인데 그 사실이 고지되지 않았다.
    // "CWL 아닌 대상이 하나라도 있으면" 기준으로 변경 — 전체/부분 미지원 모두 집계.
    let anyNonCwl = false;
    for (const [type, dest] of [['ALERT', f.alertLogging], ['FLOW', f.flowLogging]] as const) {
      if (!dest) continue;
      const m = /^CloudWatchLogs:(.+)$/.exec(dest);
      if (m) targets.push({ firewall: f.name, region: f.region, type, group: m[1], discovered: false });
      else anyNonCwl = true;
    }
    if (anyNonCwl) unsupported += 1;
  }
  // 폴백: 관례 접두사 스캔 (콘솔 기본 명명 /aws/network-firewall/...) — 이름으로 alert/flow 분류.
  // 리뷰 MAJOR(확정): 이전엔 DescribeLogGroups가 실패(스로틀/거부)해도 그냥 catch로 삼켜
  // "발견된 로그 없음"과 똑같이 보였다 — DescribeLoggingConfiguration이 이미 거부된
  // SCP류 환경에서 이 폴백까지 실패하면 "CloudWatch Logs 대상 로그 없음"으로 렌더링돼,
  // 이 폴백이 존재하는 이유였던 "unknown ≠ off" 계약을 이 경로 자신이 어겼다.
  // 또한 미순회였던 NextToken도 페이지네이션해 1페이지 너머의 로그 그룹을 놓치지 않는다.
  let discoveryFailed = false;
  for (const region of discoverRegions) {
    try {
      let nextToken: string | undefined;
      do {
        const r = await logs(region).send(new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/network-firewall', nextToken }));
        for (const g of r.logGroups ?? []) {
          const name = g.logGroupName ?? '';
          const lower = name.toLowerCase();
          const type = lower.includes('alert') ? 'ALERT' : lower.includes('flow') ? 'FLOW' : null;
          if (type) targets.push({ firewall: '(discovered)', region, type, group: name, discovered: true });
        }
        nextToken = r.nextToken;
      } while (nextToken);
    } catch { discoveryFailed = true; }
  }
  return { targets, unsupported, discoveryFailed };
}

/** Alert/Flow 로그 Insights 집계 — 그룹별 병렬 실행 후 병합, 개별 실패는 failed로 degrade. */
export async function anfwLogsAnalysis(rangeSec: number): Promise<AnfwLogsAnalysis> {
  return cached(`l|${rangeSec}`, async () => {
    const { targets, unsupported, discoveryFailed } = await resolveTargets(rangeSec);
    const failed: string[] = [];
    // 로그 그룹 발견 자체가 실패(스로틀/거부)한 것과 "발견됐지만 로그가 없음"을 구분 —
    // 전자를 후자로 렌더링하면 SCP 거부 환경에서 "로그 없음"이라는 거짓 all-clear가 된다.
    if (discoveryFailed) failed.push('logDiscovery');
    // 리뷰 MAJOR: targets는 방화벽 단위라, 중앙 공용 로그 그룹으로 로깅하는 방화벽이
    // 2개 이상이면 같은 (region, group)이 그대로 두 번 나열된다 — 아래 query 단위 집계가
    // 그룹당 한 번이 아니라 대상 수만큼 실행돼 모든 합계·Top 리스트가 배로 부풀려진다.
    // (region, type, group) 단위로 중복 제거해 쿼리는 그룹당 정확히 한 번만 실행.
    const dedupeByGroup = (ts: AnfwLogTarget[]): AnfwLogTarget[] => {
      const seen = new Map<string, AnfwLogTarget>();
      for (const t of ts) {
        const key = `${t.region}|${t.type}|${t.group}`;
        if (!seen.has(key)) seen.set(key, t);
      }
      return [...seen.values()];
    };
    const alertTargets = dedupeByGroup(targets.filter((t) => t.type === 'ALERT'));
    const flowTargets = dedupeByGroup(targets.filter((t) => t.type === 'FLOW'));

    const runMerged = async (ts: AnfwLogTarget[], key: string, query: string): Promise<Row[]> => {
      const rows: Row[] = [];
      // 리뷰 MAJOR: "그룹 중 하나라도 성공하면 ok"였던 이전 계약은 실패한 그룹의 트래픽이
      // 조용히 누락된 채 완전한 결과처럼 보이게 만든다(무신호 총계 축소) — all-groups
      // 성공이어야 failed에서 빠진다(하나라도 실패하면 이 쿼리 키를 degrade로 표시).
      let anyFail = false;
      await Promise.all(ts.map(async (t) => {
        try {
          rows.push(...await runInsights(t.region, t.group, query, rangeSec));
        } catch { anyFail = true; /* 그룹 단위 degrade */ }
      }));
      if (anyFail) failed.push(key);
      return rows;
    };

    let alert: AnfwAlertAnalytics | null = null;
    if (alertTargets.length > 0) {
      const [totals, byAction, topSig, topSrc, topDst] = await Promise.all([
        runMerged(alertTargets, 'alertTotals', `filter event.event_type = 'alert' | stats count(*) as cnt`),
        runMerged(alertTargets, 'alertByAction', `fields event.alert.action as action | filter event.event_type = 'alert' | stats count(*) as cnt by action | sort cnt desc`),
        runMerged(alertTargets, 'alertTopSignatures', `fields event.alert.signature_id as sid, event.alert.signature as sig | filter event.event_type = 'alert' | stats count(*) as cnt by sid, sig | sort cnt desc | limit 10`),
        runMerged(alertTargets, 'alertTopSources', `fields event.src_ip as src | filter event.event_type = 'alert' | stats count(*) as cnt by src | sort cnt desc | limit 10`),
        runMerged(alertTargets, 'alertTopDests', `fields concat(event.dest_ip, ':', event.dest_port) as dst | filter event.event_type = 'alert' | stats count(*) as cnt by dst | sort cnt desc | limit 10`),
      ]);
      const merge = (rows: Row[], nameField: string) => {
        const m = new Map<string, number>();
        for (const r of rows) {
          const k = r[nameField];
          if (k == null || k === '') continue;
          m.set(k, (m.get(k) ?? 0) + num(r.cnt));
        }
        return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);
      };
      const sigMap = new Map<string, { sid: string; signature: string; value: number }>();
      for (const r of topSig) {
        const key = `${r.sid}|${r.sig}`;
        const cur = sigMap.get(key) ?? { sid: r.sid ?? '', signature: r.sig ?? '', value: 0 };
        cur.value += num(r.cnt);
        sigMap.set(key, cur);
      }
      alert = {
        totalAlerts: totals.reduce((s, r) => s + num(r.cnt), 0),
        byAction: merge(byAction, 'action'),
        topSignatures: [...sigMap.values()].sort((a, b) => b.value - a.value).slice(0, 10),
        topSources: merge(topSrc, 'src'),
        topDests: merge(topDst, 'dst'),
      };
    }

    let flow: AnfwFlowAnalytics | null = null;
    if (flowTargets.length > 0) {
      // Top talker(3필드 group-by)는 대용량 스캔이라 창을 최대 6h로 제한 — 실측: 24h 566만 행에서
      // 폴링 상한 초과. totals/proto(단순 집계)는 요청 범위 그대로.
      const talkersWindowSec = Math.min(rangeSec, 21600);
      const runMergedWindow = async (ts: AnfwLogTarget[], key: string, query: string, windowSec: number): Promise<Row[]> => {
        const rows: Row[] = [];
        let anyFail = false;
        await Promise.all(ts.map(async (t) => {
          try {
            rows.push(...await runInsights(t.region, t.group, query, windowSec));
          } catch { anyFail = true; /* 그룹 단위 degrade */ }
        }));
        if (anyFail) failed.push(key);
        return rows;
      };
      const [totals, talkers, byProto] = await Promise.all([
        runMerged(flowTargets, 'flowTotals', `filter event.event_type = 'netflow' | stats count(*) as cnt, sum(event.netflow.bytes) as bytes`),
        runMergedWindow(flowTargets, 'flowTopTalkers', `fields event.src_ip as src, event.dest_ip as dst | filter event.event_type = 'netflow' | stats sum(event.netflow.bytes) as bytes, count(*) as cnt by src, dst | sort bytes desc | limit 10`, talkersWindowSec),
        runMerged(flowTargets, 'flowByProto', `fields event.proto as proto | filter event.event_type = 'netflow' | stats count(*) as cnt by proto | sort cnt desc`),
      ]);
      const protoMap = new Map<string, number>();
      for (const r of byProto) {
        if (!r.proto) continue;
        protoMap.set(r.proto, (protoMap.get(r.proto) ?? 0) + num(r.cnt));
      }
      flow = {
        totalFlows: totals.reduce((s, r) => s + num(r.cnt), 0),
        totalBytes: totals.reduce((s, r) => s + num(r.bytes), 0),
        talkersWindowSec,
        topTalkers: talkers
          .map((r) => ({ src: r.src ?? '', dst: r.dst ?? '', bytes: num(r.bytes), flows: num(r.cnt) }))
          .filter((t) => t.src)
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 10),
        byProto: [...protoMap.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      };
    }

    return { targets, unsupportedDestinations: unsupported, alert, flow, failed, rangeSec };
  });
}
