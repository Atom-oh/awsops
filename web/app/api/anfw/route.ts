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

// 리뷰 MAJOR(확정, 라운드5): "리전당 최대 6페이지" 고정 상한은 리전 수가 늘어나면 여전히
// 총 소요시간이 리전 수에 선형으로 비례해 늘어난다 — 이 앱 자신의 Describe* read
// 이벤트도 EventSource=network-firewall.amazonaws.com에 걸리므로(ReadOnly로만 클라이언트
// 필터) 대시보드가 자주 열리는 계정에서는 리전마다 6페이지 캡에 realistic하게 도달한다.
// 17개 리전이면 페이싱만으로 6×17×0.6s=61.2s로 maxDuration=60/CloudFront
// origin_read_timeout=60을 넘긴다 — "60초 예산에 맞다"는 이전 코멘트는 리전 수가 늘면
// 거짓이 된다. 페이지 상한이 아니라 **전체 요청의 남은 시간(데드라인)**을 기준으로
// 멈춘다 — 리전이 아무리 많아도 총 소요시간은 데드라인 근처에서 수렴하고, 데드라인
// 안에 처리 못 한 리전은 capExhausted로 표시돼 "변경 없음"이 아니라 "확인 못 함"으로 남는다.
const AUDIT_BUDGET_MS = 40_000; // maxDuration=60에서 anfwAnalysis()·응답 직렬화 여유 20s를 뺀 예산
async function lookupNetworkFirewallMutations(region: string, deadlineAt: number): Promise<{ raw: unknown[]; failed: boolean; capExhausted: boolean }> {
  const matched: unknown[] = [];
  let NextToken: string | undefined;
  let page = 0;
  let deadlineHit = false;
  try {
    do {
      if (Date.now() >= deadlineAt) { deadlineHit = true; break; }
      await acquireAuditPaceSlot();
      const r: { Events?: { EventSource?: string; ReadOnly?: string }[]; NextToken?: string } = await ct(region).send(new LookupEventsCommand({
        MaxResults: 50,
        LookupAttributes: [{ AttributeKey: 'EventSource', AttributeValue: 'network-firewall.amazonaws.com' }],
        NextToken,
      }));
      for (const e of r.Events ?? []) if (e.ReadOnly !== 'true') matched.push(e);
      NextToken = r.NextToken;
      page += 1;
      if (matched.length >= 30 || page >= 6 || !NextToken) break;
    } while (NextToken);
    // 페이지 상한이나 데드라인에 걸렸는데 NextToken이 남아있거나 아예 시도조차 못 했으면
    // 탐색이 미완결이다 — failed:false로 보고하면 "더 없음=진짜 없음"처럼 보인다.
    const capExhausted = deadlineHit || (page >= 6 && !!NextToken);
    return { raw: matched, failed: false, capExhausted };
  } catch { return { raw: matched, failed: true, capExhausted: false }; }
}

// 리뷰 MAJOR(확정): 리전별 600ms 페이싱은 각 리전의 Promise.all이 "동시에" 자기 루프를
// 도는 동안만 유효했다 — 리전이 N개면 계정 전체 공유 ~2 TPS 쿼터를 N배로 초과했다(코드가
// 스스로 피하려던 스로틀을 오히려 상시화). 리전·페이지 구분 없이 전역 큐 하나로
// 직렬화 — 매 LookupEvents 호출 사이에 항상 ≥600ms를 보장한다.
let auditPaceGate: Promise<void> = Promise.resolve();
function acquireAuditPaceSlot(): Promise<void> {
  const prevSlot = auditPaceGate;
  let release: () => void;
  auditPaceGate = new Promise<void>((res) => { release = res; });
  return prevSlot.then(() => new Promise<void>((res) => setTimeout(res, 600))).then(() => { release(); });
}

async function auditEvents(): Promise<{ events: AnfwAuditEvent[]; degradedRegions: string[] }> {
  return cachedAudit('audit', async () => {
    const regions = new Set<string>([REGION]);
    // 리뷰 MAJOR(확정): 리전 집합을 firewalls[].region(현재 방화벽이 있는 리전만)에서
    // 채우면, 어떤 리전의 "마지막" 방화벽이 삭제된 경우 그 리전이 통째로 감사 대상에서
    // 빠진다 — 감사에서 가장 보고 싶은 DeleteFirewall 이벤트 자체가 "90일간 변경 없음"
    // 뒤로 숨는다. anfwAnalysis()가 실제로 조회를 시도한 scannedRegions(인벤토리 기반
    // 전체 리전)를 써야 firewalls 유무와 무관하게 전 리전이 감사된다.
    // 데드라인은 auditEvents() 진입 시점부터 계산 — anfwAnalysis() 자체가 걸리는 시간도
    // 예산에서 빠져나간다(그래야 리전 조회 시작 전에 이미 예산을 다 써버리는 경우도 처리).
    const deadlineAt = Date.now() + AUDIT_BUDGET_MS;
    const preDegraded = new Set<string>();
    try {
      const a = await anfwAnalysis(86400);
      a.scannedRegions.forEach((r) => regions.add(r));
      a.degradedRegions.forEach((r) => { regions.add(r); preDegraded.add(r); });
    } catch { /* 홈 리전만 */ }
    const perRegion = await Promise.all([...regions].map(async (region) => {
      const out: AnfwAuditEvent[] = [];
      let degraded = preDegraded.has(region);
      // 계정 전체 ~2 TPS 공유 페이싱은 lookupNetworkFirewallMutations 내부의 전역
      // acquireAuditPaceSlot 큐가 담당(리전×페이지 전체를 직렬화) — 페이지 상한이 아니라
      // 공유 데드라인(deadlineAt)까지만 진행해 리전 수가 늘어도 총 소요시간이 예산 안에
      // 수렴한다(뒤로 밀린 리전은 capExhausted로 표시돼 "변경 없음"과 구분된다).
      const { raw, failed, capExhausted } = await lookupNetworkFirewallMutations(region, deadlineAt);
      // capExhausted도 degraded 신호다 — 페이지 상한에 걸려 남은 NextToken을 못 본
      // 상태를 "변경 없음"으로 단정하면 안 된다(리뷰 MAJOR, failed와 동일 계약).
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
