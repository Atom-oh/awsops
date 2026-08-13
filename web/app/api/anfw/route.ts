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
const AUDIT_EVENT_NAMES = [
  'CreateFirewall', 'DeleteFirewall', 'AssociateFirewallPolicy', 'AssociateSubnets', 'DisassociateSubnets',
  'CreateFirewallPolicy', 'UpdateFirewallPolicy', 'DeleteFirewallPolicy',
  'CreateRuleGroup', 'UpdateRuleGroup', 'DeleteRuleGroup',
  'UpdateLoggingConfiguration', 'UpdateFirewallDeleteProtection', 'UpdateSubnetChangeProtection',
];

/** ANFW 구성 변경 감사 (owner 가이드 3계층): 방화벽 리전의 CloudTrail에서 변경 이벤트만
 *  이름별로 조회 (LookupEvents 2TPS — 리전 내 순차 실행 + 페이싱). */
async function auditEvents(): Promise<{ events: AnfwAuditEvent[]; degradedRegions: string[] }> {
  return cachedAudit('audit', async () => {
    const regions = new Set<string>([REGION]);
    try { (await anfwAnalysis(86400)).firewalls.forEach((f) => regions.add(f.region)); } catch { /* 홈 리전만 */ }
    const perRegion = await Promise.all([...regions].map(async (region) => {
      const out: AnfwAuditEvent[] = [];
      // 리뷰 MAJOR: 이벤트명 단위 실패(스로틀 등)를 조용히 삼키면 "조회 범위 내 변경 없음"과
      // "조회 자체가 실패함"이 구분 안 된다 — 감사(audit) 화면에서 가장 나쁜 오류 형태.
      // 실패한 이벤트명이 하나라도 있으면 이 리전을 degraded로 표시해 "변경 없음" 단정을 막는다.
      let degraded = false;
      for (let i = 0; i < AUDIT_EVENT_NAMES.length; i++) {
        const name = AUDIT_EVENT_NAMES[i];
        // 계정 전체 ~2 TPS 공유 — 순차 호출 사이 페이싱해 스로틀(=삼켜진 실패의 흔한 원인) 완화.
        if (i > 0) await new Promise((r) => setTimeout(r, 600));
        try {
          const r = await ct(region).send(new LookupEventsCommand({
            MaxResults: 10,
            LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: name }],
          }));
          for (const e of r.Events ?? []) {
            if (e.EventSource !== 'network-firewall.amazonaws.com') continue;
            const res = e.Resources?.[0];
            out.push({
              time: e.EventTime instanceof Date ? e.EventTime.toISOString() : String(e.EventTime ?? ''),
              name: e.EventName ?? '',
              user: e.Username ?? '',
              region,
              resourceType: res?.ResourceType?.replace(/^AWS::NetworkFirewall::/, '') ?? '',
              resourceName: res?.ResourceName?.split('/').pop() ?? '',
              readOnly: false,
            });
          }
        } catch { degraded = true; }
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
