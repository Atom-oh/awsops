import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { verifyUser } from '@/lib/auth';
import { anfwAnalysis } from '@/lib/anfw';
import { anfwLogsAnalysis } from '@/lib/anfw-logs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ctClients = new Map<string, CloudTrailClient>();
const ct = (r: string) => {
  let c = ctClients.get(r);
  if (!c) { c = new CloudTrailClient({ region: r }); ctClients.set(r, c); }
  return c;
};

// 리뷰 MAJOR: auditEvents()에 TTL 캐시가 없어 페이지 마운트마다 리전당 14회 순차
// LookupEvents가 나가고(계정 전체 ~2 TPS 공유), 이 로그인 사용자 누구나 새로고침하면
// CloudTrail 탭 등 다른 패널까지 강등된다. anfw.ts/sg-analysis.ts와 동일한 4분 TTL.
const AUDIT_TTL_MS = 4 * 60_000;
const auditCache = new Map<string, { at: number; v: unknown }>();
const auditInflight = new Map<string, Promise<unknown>>();
async function cachedAudit<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = auditCache.get(key);
  if (hit && Date.now() - hit.at < AUDIT_TTL_MS) return hit.v as T;
  const running = auditInflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { auditCache.set(key, { at: Date.now(), v }); return v; }).finally(() => auditInflight.delete(key));
  auditInflight.set(key, p);
  return p;
}

export interface AnfwAuditEvent {
  time: string; name: string; user: string; region: string;
  resourceType: string; resourceName: string; readOnly: boolean;
}

// ANFW 변경(mutation) API 이벤트명 — EventName 단위 조회가 정확하다:
// EventSource 단위 조회는 이 앱 자신의 Describe* read 이벤트가 최근 목록을 가득 채워
// (실측: 최근 50건 전부 read) 과거 write가 절대 안 보인다. LookupEvents는 호출당
// LookupAttribute 1개 제한이라 EventSource+ReadOnly 조합 불가 → 변경 API를 이름별 조회.
// 리뷰 MAJOR(확정): 페이지가 표시하는 보호 상태 중 UpdateSubnetChangeProtection만 감사
// 대상이었고 정책 변경 보호·TLS 검사 구성 변경 이벤트명이 누락돼 있었다 — 그 축의
// 변경이 "감사 범위 밖"으로 조용히 빠졌다.
const AUDIT_EVENT_NAMES = [
  'CreateFirewall', 'DeleteFirewall', 'AssociateFirewallPolicy', 'AssociateSubnets', 'DisassociateSubnets',
  'CreateFirewallPolicy', 'UpdateFirewallPolicy', 'DeleteFirewallPolicy',
  'CreateRuleGroup', 'UpdateRuleGroup', 'DeleteRuleGroup',
  'UpdateLoggingConfiguration', 'UpdateFirewallDeleteProtection', 'UpdateSubnetChangeProtection',
  'UpdateFirewallPolicyChangeProtection', 'UpdateFirewallEncryptionConfiguration',
];

// 리뷰 MAJOR(확정): 리전별 600ms 페이싱은 각 리전의 Promise.all이 "동시에" 자기 루프를
// 도는 동안만 유효했다 — 리전이 N개면 계정 전체 공유 ~2 TPS 쿼터를 N배로 초과했다(코드가
// 스스로 피하려던 스로틀을 오히려 상시화). 리전·이벤트명·페이지 구분 없이 전역 큐 하나로
// 직렬화 — 매 LookupEvents 호출 사이에 항상 ≥600ms를 보장한다.
let auditPaceGate: Promise<void> = Promise.resolve();
function acquireAuditPaceSlot(): Promise<void> {
  const prevSlot = auditPaceGate;
  let release: () => void;
  auditPaceGate = new Promise<void>((res) => { release = res; });
  return prevSlot.then(() => new Promise<void>((res) => setTimeout(res, 600))).then(() => { release(); });
}

/** 이 이벤트명이 목표(10건) 찾을 때까지, 또는 페이지 상한(5)까지 NextToken 순회.
 *  리뷰 MAJOR(확정): CreateRuleGroup/UpdateRuleGroup/DeleteRuleGroup은 WAFv2 이벤트명과도
 *  동일 — MaxResults:10 단일 페이지 + 클라이언트 사이드 EventSource 필터만으로는 계정에
 *  WAF 활동이 있으면 그 페이지가 WAF 이벤트로 가득 차 실제 ANFW 변경이 안 보일 수 있다. */
async function lookupNetworkFirewallEvents(region: string, name: string): Promise<{ raw: unknown[]; failed: boolean; capExhausted: boolean }> {
  const matched: unknown[] = [];
  let NextToken: string | undefined;
  let page = 0;
  try {
    do {
      await acquireAuditPaceSlot();
      const r: { Events?: { EventSource?: string }[]; NextToken?: string } = await ct(region).send(new LookupEventsCommand({
        MaxResults: 10,
        LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: name }],
        NextToken,
      }));
      for (const e of r.Events ?? []) if (e.EventSource === 'network-firewall.amazonaws.com') matched.push(e);
      NextToken = r.NextToken;
      page += 1;
      if (matched.length >= 10 || page >= 5 || !NextToken) break;
    } while (NextToken);
    // 리뷰 MAJOR(확정): 페이지 상한(5)에 걸렸는데 NextToken이 남아있으면(WAF 등 다른
    // 서비스의 동일 이벤트명이 결과를 가득 채운 전형적 신호) 탐색이 미완결이다 — 이전엔
    // failed:false로 보고해 "10건 못 찾음=진짜 없음"처럼 보였다.
    const capExhausted = page >= 5 && !!NextToken;
    return { raw: matched, failed: false, capExhausted };
  } catch { return { raw: matched, failed: true, capExhausted: false }; }
}

async function auditEvents(): Promise<{ events: AnfwAuditEvent[]; degradedRegions: string[] }> {
  return cachedAudit('audit', async () => {
    const regions = new Set<string>([REGION]);
    // 리뷰 MAJOR(확정): anfwAnalysis()가 자체 degradedRegions로 표시한 리전(List/Describe
    // 부분 실패)은 firewalls 목록에 아예 안 잡히므로 이전엔 audit 조회 대상에서도, 우리
    // 자신의 degradedRegions에서도 조용히 빠졌다 — "변경 없음"을 그 리전까지 확정해버렸다.
    // 방화벽 목록 자체가 불완전한 리전도 조회 대상에 넣고 선제적으로 degraded로 시작한다.
    const preDegraded = new Set<string>();
    try {
      const a = await anfwAnalysis(86400);
      a.firewalls.forEach((f) => regions.add(f.region));
      a.degradedRegions.forEach((r) => { regions.add(r); preDegraded.add(r); });
    } catch { /* 홈 리전만 */ }
    const perRegion = await Promise.all([...regions].map(async (region) => {
      const out: AnfwAuditEvent[] = [];
      // 리뷰 MAJOR: 이벤트명 단위 실패(스로틀 등)를 조용히 삼키면 "조회 범위 내 변경 없음"과
      // "조회 자체가 실패함"이 구분 안 된다 — 감사(audit) 화면에서 가장 나쁜 오류 형태.
      // 실패한 이벤트명이 하나라도 있으면 이 리전을 degraded로 표시해 "변경 없음" 단정을 막는다.
      let degraded = preDegraded.has(region);
      for (let i = 0; i < AUDIT_EVENT_NAMES.length; i++) {
        const name = AUDIT_EVENT_NAMES[i];
        // 계정 전체 ~2 TPS 공유 페이싱은 lookupNetworkFirewallEvents 내부의 전역
        // acquireAuditPaceSlot 큐가 담당(리전×이벤트명×페이지 전체를 직렬화) — 여기서
        // 추가로 sleep하면 이미 직렬화된 호출을 이중으로 늦추기만 한다.
        const { raw, failed, capExhausted } = await lookupNetworkFirewallEvents(region, name);
        // capExhausted도 degraded 신호다 — 페이지 상한에 걸려 남은 NextToken을 못 본
        // 상태를 "이 이벤트명은 변경 없음"으로 단정하면 안 된다(리뷰 MAJOR, failed와 동일 계약).
        if (failed || capExhausted) degraded = true;
        for (const ev of raw as { EventTime?: Date | string; EventName?: string; Username?: string; Resources?: { ResourceType?: string; ResourceName?: string }[] }[]) {
          const res = ev.Resources?.[0];
          out.push({
            time: ev.EventTime instanceof Date ? ev.EventTime.toISOString() : String(ev.EventTime ?? ''),
            name: ev.EventName ?? '',
            user: ev.Username ?? '',
            region,
            resourceType: res?.ResourceType?.replace(/^AWS::NetworkFirewall::/, '') ?? '',
            resourceName: res?.ResourceName?.split('/').pop() ?? '',
            readOnly: false,
          });
        }
      }
      return { region, out, degraded };
    }));
    const events = perRegion.flatMap((r) => r.out).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 50);
    const degradedRegions = perRegion.filter((r) => r.degraded).map((r) => r.region);
    return { events, degradedRegions };
  });
}

// Network Firewall 리스트+분석: 방화벽/정책/룰 그룹 리전 fan-out +
// AWS/NetworkFirewall 메트릭 트래픽·드롭 집계 + 보호/로깅/용량/미연결 분석.
// ?view=logs → Alert/Flow 로그 Insights 집계 · ?view=audit → CloudTrail 변경 감사.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const rangeRaw = Number(url.searchParams.get('range') ?? 86400);
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 86400;
  const view = url.searchParams.get('view');
  try {
    if (view === 'logs') return Response.json(await anfwLogsAnalysis(range));
    if (view === 'audit') return Response.json(await auditEvents());
    return Response.json(await anfwAnalysis(range));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
