'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Flame, Layers, Scroll, Shield, ShieldAlert, Unplug } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import DetailPanel from '@/components/ui/DetailPanel';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { RangePicker, TH, MONO, TD, DANGER, dash } from '@/components/inventory/metrics/shared';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import HBarList from '@/components/charts/HBarList';
import DiagnosisGuide from '@/components/inventory/metrics/DiagnosisGuide';
import { ANFW_GUIDE } from '@/components/inventory/metrics/guides';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { AnfwAnalysis, AnfwFirewallRow, AnfwPolicyRow, AnfwRuleGroupRow } from '@/lib/anfw';
import type { AnfwLogsAnalysis } from '@/lib/anfw-logs';
import type { InvType } from '@/lib/inventory-types';

/** /api/anfw?view=audit 응답 행 (라우트와 lockstep). */
interface AuditEvent {
  time: string; name: string; user: string; region: string;
  resourceType: string; resourceName: string; readOnly: boolean;
}

// /network-firewall — AWS Network Firewall 리스트+분석 (Network 메뉴). 방화벽/정책/룰 그룹을
// 리전 fan-out으로 수집하고 AWS/NetworkFirewall 메트릭(기간 Sum)으로 트래픽·드롭을 집계한다.
// 분석 렌즈: 보호 설정 off(변경·삭제 사고 노출) · ALERT 로깅 갭(위협 가시성 없음) ·
// stateless 기본 aws:pass(스테이트풀 엔진 우회) · 룰 그룹 용량(≥80%)·미연결(정리 후보) ·
// 엔드포인트/동기화 이상. 데이터 계층은 lib/anfw.ts(4분 TTL 캐시).

// 정적 셀 마크 — props/state에 의존하지 않으므로 모듈 스코프 상수(참조 안정성 → 아래
// useMemo/useCallback deps에 안전하게 넣을 수 있음).
const offBadge = <Badge tone="negative" variant="soft">off</Badge>;
const onMark = <span className="text-emerald-700">on</span>;

/** 사람 단위 수치 포맷 (패킷 카운트). null=메트릭 없음. */
function fmtCount(v: number | null): string | null {
  if (v == null) return null;
  if (v < 10_000) return v.toLocaleString();
  const units = ['', 'K', 'M', 'B'];
  let n = v;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

/** 사람 단위 바이트 포맷. */
function fmtBytes(v: number | null): string | null {
  if (v == null) return null;
  if (v === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1)} ${units[i]}`;
}

const FW_DETAIL_SPEC: InvType = {
  label: 'Network Firewall', group: 'Network', stateKey: 'status',
  columns: [
    { key: 'name', label: 'Firewall' }, { key: 'region', label: 'Region' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'policy_name', label: 'Firewall Policy' }, { key: 'status', label: 'Status' },
    { key: 'sync_summary', label: 'Config Sync' }, { key: 'encryption_type', label: 'Encryption' },
    { key: 'endpoints', label: 'Endpoints (AZ)' },
    { key: 'delete_protection', label: 'Delete Protection' },
    { key: 'subnet_change_protection', label: 'Subnet Change Protection' },
    { key: 'policy_change_protection', label: 'Policy Change Protection' },
    { key: 'alert_logging', label: 'ALERT Log' }, { key: 'flow_logging', label: 'FLOW Log' }, { key: 'tls_logging', label: 'TLS Log' },
    { key: 'received_packets', label: 'Received Packets' }, { key: 'received_bytes', label: 'Received Bytes' },
    { key: 'passed_packets', label: 'Passed Packets' }, { key: 'dropped_packets', label: 'Dropped Packets' },
    { key: 'rejected_packets', label: 'Rejected Packets' }, { key: 'invalid_dropped', label: 'Invalid Dropped' },
    { key: 'other_dropped', label: 'Other Dropped' }, { key: 'stream_exception_packets', label: 'Stream Exception' },
    { key: 'tls_received_packets', label: 'TLS Received' }, { key: 'tls_passed_packets', label: 'TLS Passed' },
    { key: 'tls_dropped_packets', label: 'TLS Dropped' }, { key: 'tls_rejected_packets', label: 'TLS Rejected' },
    { key: 'drop_rate_pct', label: 'Drop Rate %' }, { key: 'az_engine_metrics', label: 'Per AZ / Engine' },
  ],
  sections: [
    { label: 'Identity', keys: ['name', 'region', 'vpc_id', 'policy_name', 'status', 'sync_summary', 'encryption_type'] },
    { label: 'Endpoints', keys: ['endpoints'] },
    { label: 'Protection', keys: ['delete_protection', 'subnet_change_protection', 'policy_change_protection'] },
    { label: 'Logging', keys: ['alert_logging', 'flow_logging', 'tls_logging'] },
    { label: 'Traffic', keys: ['received_packets', 'received_bytes', 'passed_packets', 'dropped_packets', 'rejected_packets', 'invalid_dropped', 'other_dropped', 'stream_exception_packets', 'tls_received_packets', 'tls_passed_packets', 'tls_dropped_packets', 'tls_rejected_packets', 'drop_rate_pct', 'az_engine_metrics'] },
  ],
};

const POLICY_DETAIL_SPEC: InvType = {
  label: 'Firewall Policy', group: 'Network', stateKey: 'status',
  columns: [
    { key: 'name', label: 'Policy' }, { key: 'region', label: 'Region' }, { key: 'status', label: 'Status' },
    { key: 'associations', label: 'Associations' }, { key: 'last_modified', label: 'Last Modified' },
    { key: 'stateless_groups', label: 'Stateless Rule Groups' }, { key: 'stateful_groups', label: 'Stateful Rule Groups' },
    { key: 'stateless_default_actions', label: 'Stateless Default' },
    { key: 'stateless_fragment_default_actions', label: 'Fragment Default' },
    { key: 'stateful_default_actions', label: 'Stateful Default' },
    { key: 'stateful_rule_order', label: 'Rule Order' }, { key: 'stream_exception_policy', label: 'Stream Exception Policy' },
    { key: 'consumed_stateless_capacity', label: 'Consumed Stateless Capacity' },
    { key: 'consumed_stateful_capacity', label: 'Consumed Stateful Capacity' },
  ],
  sections: [
    { label: 'Identity', keys: ['name', 'region', 'status', 'associations', 'last_modified'] },
    { label: 'Rule Groups', keys: ['stateless_groups', 'stateful_groups'] },
    { label: 'Defaults', keys: ['stateless_default_actions', 'stateless_fragment_default_actions', 'stateful_default_actions', 'stateful_rule_order', 'stream_exception_policy'] },
    { label: 'Capacity', keys: ['consumed_stateless_capacity', 'consumed_stateful_capacity'] },
  ],
};

const RG_DETAIL_SPEC: InvType = {
  label: 'Rule Group', group: 'Network', stateKey: 'status',
  columns: [
    { key: 'name', label: 'Rule Group' }, { key: 'region', label: 'Region' }, { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status' }, { key: 'last_modified', label: 'Last Modified' },
    { key: 'capacity', label: 'Capacity' }, { key: 'consumed_capacity', label: 'Consumed' },
    { key: 'capacity_pct', label: 'Capacity %' }, { key: 'associations', label: 'Associations' },
    { key: 'unassociated', label: 'Unassociated' },
  ],
  sections: [
    { label: 'Identity', keys: ['name', 'region', 'type', 'status', 'last_modified'] },
    { label: 'Capacity', keys: ['capacity', 'consumed_capacity', 'capacity_pct', 'associations', 'unassociated'] },
  ],
};

const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));

function fwDetail(r: AnfwFirewallRow): Record<string, unknown> {
  return compact({
    name: r.name, region: r.region, vpc_id: r.vpcId, policy_name: r.policyName,
    status: r.status, sync_summary: r.syncSummary, encryption_type: r.encryptionType,
    endpoints: r.endpoints.length ? r.endpoints.map((e) => `${e.az} ${e.endpointId} ${e.subnetId} ${e.status}`) : undefined,
    delete_protection: r.deleteProtection, subnet_change_protection: r.subnetChangeProtection,
    policy_change_protection: r.policyChangeProtection,
    alert_logging: r.alertLogging ?? (r.loggingKnown ? '(not configured)' : '(unknown — describe denied)'),
    flow_logging: r.flowLogging ?? (r.loggingKnown ? '(not configured)' : '(unknown — describe denied)'),
    tls_logging: r.tlsLogging ?? undefined,
    received_packets: fmtCount(r.receivedPackets), received_bytes: fmtBytes(r.receivedBytes),
    passed_packets: fmtCount(r.passedPackets), dropped_packets: fmtCount(r.droppedPackets),
    rejected_packets: fmtCount(r.rejectedPackets), invalid_dropped: fmtCount(r.invalidDropped),
    other_dropped: fmtCount(r.otherDropped), stream_exception_packets: fmtCount(r.streamExceptionPackets),
    tls_received_packets: fmtCount(r.tlsReceivedPackets), tls_passed_packets: fmtCount(r.tlsPassedPackets),
    tls_dropped_packets: fmtCount(r.tlsDroppedPackets), tls_rejected_packets: fmtCount(r.tlsRejectedPackets),
    drop_rate_pct: r.dropRatePct == null ? undefined : `${r.dropRatePct}%`,
    az_engine_metrics: r.metricRows.length ? r.metricRows : undefined,
  });
}

function policyDetail(r: AnfwPolicyRow): Record<string, unknown> {
  return compact({
    name: r.name, region: r.region, status: r.status, associations: r.associations,
    last_modified: r.lastModified,
    stateless_groups: r.statelessGroups.length ? r.statelessGroups : undefined,
    stateful_groups: r.statefulGroups.length ? r.statefulGroups : undefined,
    stateless_default_actions: r.statelessDefaultActions.join(', ') || undefined,
    stateless_fragment_default_actions: r.statelessFragmentDefaultActions.join(', ') || undefined,
    stateful_default_actions: r.statefulDefaultActions.join(', ') || undefined,
    stateful_rule_order: r.statefulRuleOrder, stream_exception_policy: r.streamExceptionPolicy,
    consumed_stateless_capacity: r.consumedStatelessCapacity, consumed_stateful_capacity: r.consumedStatefulCapacity,
  });
}

function rgDetail(r: AnfwRuleGroupRow): Record<string, unknown> {
  return compact({
    name: r.name, region: r.region, type: r.type, status: r.status, last_modified: r.lastModified,
    capacity: r.capacity, consumed_capacity: r.consumedCapacity,
    capacity_pct: r.capacityPct == null ? undefined : `${r.capacityPct}%`,
    associations: r.associations, unassociated: r.unassociated,
  });
}

type Selected =
  | { kind: 'fw'; row: AnfwFirewallRow }
  | { kind: 'policy'; row: AnfwPolicyRow }
  | { kind: 'rg'; row: AnfwRuleGroupRow };

type Variant = 'default' | 'danger' | 'warn';

/** KPI 배지 판정 — 확인된 위험(danger)은 절대 저하(degraded)로 강등하지 않는다.
 *  degraded는 "더 나쁠 수도 있다"는 뜻일 뿐, 이미 확인된 위험을 무효화하는 근거가
 *  아니다. danger가 아닐 때만 degraded가 warn으로 격상된다. (dx.ts와 동일 계약) */
function kpiVariant(hasRealDanger: boolean, degraded: boolean): Variant {
  if (hasRealDanger) return 'danger';
  if (degraded) return 'warn';
  return 'default';
}

/** kpiVariant의 warn-only 변형 — 룰 그룹 용량 임박·보호 미설정처럼 원래도 'danger'가
 *  아니라 'warn'까지만 올라가는 조건에 쓴다. degraded든 실측 경고든 danger로 승격하지 않는다
 *  (kpiVariant를 그대로 쓰면 원래 warn이던 조건이 danger로 잘못 격상된다). */
function warnVariant(hasWarn: boolean, degraded: boolean): Variant {
  return hasWarn || degraded ? 'warn' : 'default';
}

export default function NetworkFirewallPage() {
  const { tt } = useI18n();
  const [range, setRange] = useState(86400);
  const [data, setData] = useState<AnfwAnalysis | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Selected | null>(null);
  // 로그 분석(Insights)·변경 감사(CloudTrail)는 별도 lazy fetch — 메인 리스트를 막지 않음.
  const [logsData, setLogsData] = useState<AnfwLogsAnalysis | null>(null);
  const [logsErr, setLogsErr] = useState('');
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditErr, setAuditErr] = useState('');
  const [auditDegradedRegions, setAuditDegradedRegions] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    // 리뷰 MINOR: range 변경 시 이전 range의 data/열린 DetailPanel이 새 응답이 올 때까지(또는
    // 실패 시 영원히) 그대로 남아있었다 — 로딩 표시 없이 이전 기간 수치를 보여주는 오정보.
    setData(null);
    setSelected(null);
    setErr('');
    fetch(`/api/anfw?range=${range}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as AnfwAnalysis;
      })
      .then((d) => { if (alive) { setData(d); setErr(''); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [range]);

  useEffect(() => {
    let alive = true;
    setLogsData(null);
    fetch(`/api/anfw?view=logs&range=${range}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as AnfwLogsAnalysis;
      })
      .then((d) => { if (alive) { setLogsData(d); setLogsErr(''); } })
      .catch((e) => { if (alive) setLogsErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [range]);

  useEffect(() => {
    let alive = true;
    fetch('/api/anfw?view=audit')
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as { events: AuditEvent[]; degradedRegions: string[] };
      })
      .then((d) => { if (alive) { setAudit(d.events); setAuditDegradedRegions(d.degradedRegions ?? []); setAuditErr(''); } })
      .catch((e) => { if (alive) setAuditErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const fws = useMemo(() => data?.firewalls ?? [], [data]);
  const policies = useMemo(() => data?.policies ?? [], [data]);
  const rgs = useMemo(() => data?.ruleGroups ?? [], [data]);

  // 도넛: 룰 그룹 타입 분포.
  const rgTypeDist = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rgs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return [...counts.entries()].map(([name, value]) => ({ name, value }));
  }, [rgs]);

  // 룰 그룹 용량 사용률 Top 10 (%).
  const rgCapacity = useMemo(() =>
    rgs
      .filter((r) => r.capacityPct != null)
      .map((r) => ({ rg: `${r.name} (${r.type.toLowerCase()})`, pct: Math.round(r.capacityPct!) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 10),
  [rgs]);

  // 룰 그룹이 실제로 ALERT 로그를 관측할 수 있는가: 룰 그룹 → (같은 리전) 정책의
  // statefulGroups에 포함 → 그 정책을 쓰는 방화벽 → 그 방화벽이 logsData.targets에 ALERT
  // CWL 타깃으로 존재. 리뷰 MAJOR(확정): `!rg.unassociated`(정책 연결 개수>0)만으로는
  // 관측 가능성이 서지 않는다 — 그 정책을 쓰는 방화벽이 하나도 없거나, 있어도 ALERT
  // 로깅이 꺼짐/unknown/S3·Firehose 대상이면 여전히 트래픽을 볼 수 없다.
  // 리뷰 MAJOR(확정): targets는 로깅 구성 조회가 거부된 리전에서 `/aws/network-firewall`
  // 접두사 발견 폴백으로 `firewall: '(discovered)'` 항목을 낸다(anfw-logs.ts 리뷰 라운드12
  // 계약) — 실제 방화벽 이름이 아니라서 region|firewall 키가 절대 매칭되지 않고, 그 결과
  // 폴백이 도는 리전의 모든 설정 룰이 "관측 불가"로 오판되어 실제 히트가 있어도 숨겨진다.
  // '(discovered)'는 리전 단위 신호로 별도 처리해 해당 리전 방화벽을 'unknown'(확정도
  // 부정도 아님)으로 분류한다. 리뷰 MAJOR(확정): 룰 그룹이 여러 방화벽에 서빙되면 그중
  // 하나만 관측돼도(some()) "관측됨"으로 쳐서, 나머지 관측 불가 방화벽을 지나는 트래픽이
  // 안 보이는데도 hits=0을 확정 idle로 표시했다 — "관측됨"(0을 신뢰)엔 전체 커버리지
  // (every)가 필요하다. 3상태(observed/unknown/unobserved)로 모델링: 전부 observed면
  // observed(0 신뢰 가능), 하나라도 unknown/observed가 섞이면 unknown(0 불신, 히트값은
  // 그래도 실측이라 표시), 전부 확정 미관측(로깅이 확인상 꺼짐)이거나 서빙 방화벽이 전혀
  // 없으면 unobserved(어떤 히트가 보이더라도 이 룰 귀속으로 볼 수 없음 — 숫자 자체를 숨김).
  type Observability = 'observed' | 'unknown' | 'unobserved';
  const firewallObservability = useMemo(() => {
    const observed = new Set<string>();
    const unknownRegions = new Set<string>();
    for (const t of logsData?.targets ?? []) {
      if (t.type !== 'ALERT') continue;
      if (t.discovered) unknownRegions.add(t.region);
      else observed.add(`${t.region}|${t.firewall}`);
    }
    return (fw: AnfwFirewallRow): Observability => {
      if (observed.has(`${fw.region}|${fw.name}`)) return 'observed';
      if (!fw.loggingKnown || unknownRegions.has(fw.region)) return 'unknown';
      return 'unobserved';
    };
  }, [logsData]);
  const combineObservability = (states: Observability[]): Observability => {
    if (states.length === 0) return 'unobserved';
    if (states.every((s) => s === 'observed')) return 'observed';
    if (states.some((s) => s === 'observed' || s === 'unknown')) return 'unknown';
    return 'unobserved';
  };
  const ruleGroupObservability = useMemo(() => {
    // 리뷰 확정(Codex stop-hook, PR #225): every()로 "서빙하는 모든 방화벽이 observed"를
    // 요구해도, 그 every()가 도는 firewalls/policies 목록 자체가 List/Describe 부분
    // 실패로 불완전하면(data.degradedRegions) — 우리가 못 찾은 정책/방화벽이 실제로는
    // 존재해 미관측일 수 있는데, 찾은 것들만 전부 observed라서 확정 idle로 오판한다.
    // 룰 그룹의 리전이 degradedRegions에 있으면(정책/방화벽/룰그룹 셋 중 하나라도 부분
    // 실패) 그 리전의 토폴로지 자체를 못 믿으므로 무조건 'unknown'으로 강제한다.
    const degradedRegions = new Set(data?.degradedRegions ?? []);
    const byKey = new Map<string, Observability[]>();
    for (const rg of rgs) byKey.set(`${rg.region}|${rg.name}`, []);
    for (const policy of policies) {
      for (const rgName of policy.statefulGroups) {
        const rgKey = `${policy.region}|${rgName}`;
        if (!byKey.has(rgKey)) continue;
        for (const fw of fws) {
          if (fw.region === policy.region && fw.policyName === policy.name) byKey.get(rgKey)!.push(firewallObservability(fw));
        }
      }
    }
    const m = new Map<string, Observability>();
    for (const rg of rgs) {
      const rgKey = `${rg.region}|${rg.name}`;
      m.set(rgKey, degradedRegions.has(rg.region) ? 'unknown' : combineObservability(byKey.get(rgKey) ?? []));
    }
    return m;
  }, [rgs, policies, fws, firewallObservability, data]);

  // Stateful 룰 히트 카운트 (2026-08 신기능과 동일 소스 — Alert 로그 집계):
  // 설정 룰 1개당 1행 (region×rg×sid 키 — SID는 룰 그룹 내에서만 유일하므로 sid 단독 키는
  // 병합 오류이고, 룰 그룹 이름은 여러 리전에 동일하게 배포될 수 있어 region도 필요 —
  // 리뷰 MAJOR: region 없는 키는 멀티 리전에서 React key 충돌을 낸다). 로그 히트는 sid
  // 단위로만 집계되고 리전을 구분하지 않아 같은 sid가 여러 룰 그룹(리전 불문)에 있으면
  // 그 그룹들 사이에 귀속 불가 — sharedSid 툴팁으로 명시하고 hits를 신뢰 가능한 숫자로
  // 취급하지 않는다. idle(매칭 0) 판정 제외: pass 룰(Alert 로그 미발생) · 관측 불가 룰
  // 그룹(정책 미연결/방화벽 없음/ALERT 로깅 꺼짐-unknown-S3대상) · 로그 히트 집계 자체가
  // 실패/청크 truncation됐거나(ruleHits=null) top-100으로 잘린 경우(hits 0 ≠ 매칭 없음).
  interface RuleHitRow {
    key: string; sid: string; msg: string; actions: string[]; hits: number;
    ruleGroups: string[]; configured: boolean; isPass: boolean;
    /** 이 룰 그룹을 서빙하는 방화벽들의 ALERT 관측 가능성(3상태) — 'observed'만 0을 신뢰. */
    observability: Observability;
    /** 같은 SID가 여러 룰 그룹에 존재 — 로그 히트를 특정 그룹에 귀속 불가. 리뷰 MAJOR(확정):
     *  숫자를 그대로 보여주면 그 그룹의 실제 트래픽처럼 오독된다 — 표시를 숨긴다(CLAUDE.md의
     *  "flagged in UI rather than counted" 서술을 실제로 구현). */
    sharedSid: boolean;
    /** 로그 집계 자체가 실패/잘렸거나(ruleHits=null) top-100 밖 — 매칭 여부 불명. */
    unknown: boolean;
    /** unknown=true인 이유 — 툴팁 문구 분기용(리뷰 MINOR: 원인이 서로 다른데 문구가 같았음). */
    unknownReason: 'failed' | 'truncated' | null;
  }
  const ruleHitRows = useMemo<RuleHitRow[]>(() => {
    const ruleHits = logsData?.alert?.ruleHits;
    // 리뷰 MAJOR(확정): 쿼리 실패/청크 truncation을 null로 신호받으면 "매칭 0"이 아니라
    // 전체를 불명으로 처리 — 실패를 확정 idle로 오판하면 정책 사각지대 경고가 거짓 양성.
    const ruleHitsFailed = ruleHits == null;
    const hits = ruleHits ?? [];
    const truncated = logsData?.alert?.ruleHitsTruncated ?? false;
    const hitsBySid = new Map<string, { hits: number; actions: Set<string>; sig: string }>();
    for (const h of hits) {
      const cur = hitsBySid.get(h.sid) ?? { hits: 0, actions: new Set<string>(), sig: h.signature };
      cur.hits += h.hits;
      if (h.action) cur.actions.add(h.action);
      hitsBySid.set(h.sid, cur);
    }
    const sidGroupCount = new Map<string, number>();
    for (const rg of rgs) for (const s of rg.statefulSids) sidGroupCount.set(s.sid, (sidGroupCount.get(s.sid) ?? 0) + 1);

    const rows: RuleHitRow[] = [];
    const configuredSids = new Set<string>();
    for (const rg of rgs) {
      for (const s of rg.statefulSids) {
        configuredSids.add(s.sid);
        const h = hitsBySid.get(s.sid);
        rows.push({
          key: `${rg.region}|${rg.name}|${s.sid}`, sid: s.sid,
          msg: s.msg ?? h?.sig ?? '',
          actions: [...new Set([s.action, ...(h?.actions ?? [])].filter((x): x is string => !!x))],
          hits: h?.hits ?? 0,
          ruleGroups: [rg.name], configured: true,
          isPass: s.action === 'pass',
          observability: ruleGroupObservability.get(`${rg.region}|${rg.name}`) ?? 'unobserved',
          sharedSid: (sidGroupCount.get(s.sid) ?? 0) > 1,
          unknown: ruleHitsFailed || (truncated && !h), // 쿼리 실패/잘린 집계 밖 — 매칭 여부 불명
          unknownReason: ruleHitsFailed ? 'failed' : (truncated && !h) ? 'truncated' : null,
        });
      }
    }
    // 어느 설정 룰 그룹에도 없는 SID (관리형 룰 그룹 등)
    if (!ruleHitsFailed) {
      for (const [sid, h] of hitsBySid) {
        if (configuredSids.has(sid)) continue;
        rows.push({
          key: `log|${sid}`, sid, msg: h.sig, actions: [...h.actions], hits: h.hits,
          ruleGroups: [], configured: false, isPass: false, observability: 'observed', sharedSid: false, unknown: false, unknownReason: null,
        });
      }
    }
    return rows.sort((a, b) => b.hits - a.hits || Number(a.sid) - Number(b.sid));
  }, [logsData, rgs, ruleGroupObservability]);
  // 히트 산출 불가(n/a): pass 룰 · 관측 불가/불확실 룰 그룹 · 공유 SID · 불명 — idle(빨간 배지)에서 제외
  const idleConfiguredRules = useMemo(
    () => ruleHitRows.filter((r) => r.configured && !r.isPass && r.observability === 'observed' && !r.sharedSid && !r.unknown && r.hits === 0).length,
  [ruleHitRows]);

  // Flow 로그 시각화 — 프로토콜 도넛(플로우 수) + Top talker 바(HBarList는 정수 표시라 MB 단위).
  const flowProtoDist = useMemo(() => logsData?.flow?.byProto ?? [], [logsData]);
  const talkerBars = useMemo(() =>
    (logsData?.flow?.topTalkers ?? []).map((t) => ({
      pair: `${t.src} → ${t.dst}`,
      mb: Math.round(t.bytes / 1e6),
    })),
  [logsData]);

  // 점검 카드: 보호 off 또는 (조회 성공했는데) ALERT 미설정 방화벽만 나열 — "확인 불가"는 경고 아님.
  const issueFws = useMemo(() => fws.filter((f) => f.protectionsOff > 0 || (f.loggingKnown && f.alertLogging == null)), [fws]);

  // 로깅 셀 3상태: on / off / 확인 불가(조회 거부 — 미설정과 구분).
  // 리뷰 MINOR: offBadge/onMark/logCell가 렌더마다 새 참조로 재생성돼 fwColumns의 useMemo가
  // 매번 깨졌다 — offBadge/onMark는 모듈 스코프 상수로, logCell은 useCallback(deps=[tt])으로 고정.
  const logCell = useCallback((f: AnfwFirewallRow, dest: string | null) => !f.loggingKnown
    ? <span className="text-ink-400" title={tt('로깅 구성 조회가 거부되어 설정 여부를 알 수 없음 (미설정과 다름)')}>{tt('확인 불가')}</span>
    : dest ? onMark : offBadge, [tt]);

  const fwColumns = useMemo<MetricCol<AnfwFirewallRow>[]>(() => [
    {
      key: 'name', label: 'Firewall', mono: true,
      title: tt('상태 비정상, 구성 미동기화 또는 READY 아닌 엔드포인트가 있는 방화벽은 빨간색'),
      value: (r) => r.name,
      danger: (r) => r.down,
    },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    { key: 'vpc', label: 'VPC', mono: true, facet: true, value: (r) => r.vpcId || null },
    { key: 'policy', label: 'Policy', mono: true, value: (r) => r.policyName || null },
    { key: 'status', label: 'State', facet: true, value: (r) => r.status },
    {
      key: 'sync', label: 'Sync',
      title: tt('ConfigurationSyncStateSummary — IN_SYNC 외 값은 구성 미반영'),
      value: (r) => r.syncSummary,
      danger: (r) => r.syncSummary != null && r.syncSummary !== 'IN_SYNC',
    },
    {
      key: 'endpoints', label: tt('엔드포인트'), type: 'num',
      title: tt('AZ별 방화벽 엔드포인트 수 — READY 아닌 엔드포인트는 빨간색'),
      value: (r) => r.endpoints.length,
      render: (r) => r.endpointsNotReady > 0
        ? <span className="font-semibold text-rose-600">{`${r.endpoints.length - r.endpointsNotReady}/${r.endpoints.length}`}</span>
        : String(r.endpoints.length),
      danger: (r) => r.endpointsNotReady > 0,
    },
    {
      key: 'recv', label: tt('수신 패킷'), type: 'num',
      title: tt('기간 내 ReceivedPackets 합계 (AZ 합산, Engine=Stateless만 — 와이어 패킷)'),
      value: (r) => r.receivedPackets,
      render: (r) => fmtCount(r.receivedPackets) ?? dash,
    },
    {
      key: 'passed', label: tt('통과'), type: 'num',
      title: tt('기간 내 PassedPackets 합계'),
      value: (r) => r.passedPackets,
      render: (r) => fmtCount(r.passedPackets) ?? dash,
    },
    {
      key: 'dropped', label: tt('드롭'), type: 'num',
      title: tt('기간 내 DroppedPackets 합계 (무효/기타 드롭·거부는 상세 참조)'),
      value: (r) => r.droppedPackets,
      render: (r) => fmtCount(r.droppedPackets) ?? dash,
    },
    {
      key: 'droprate', label: tt('드롭율'), type: 'num',
      title: tt('(드롭+무효+기타+거부) ÷ 수신 — 방화벽이 실제로 걸러낸 비율'),
      value: (r) => r.dropRatePct,
      render: (r) => (r.dropRatePct == null ? dash : `${r.dropRatePct}%`),
    },
    {
      key: 'protect', label: tt('보호'), type: 'num',
      title: tt('꺼진 보호 설정 수 (삭제/서브넷 변경/정책 변경)'),
      value: (r) => r.protectionsOff,
      render: (r) => r.protectionsOff === 0
        ? onMark
        : <Badge tone="negative" variant="soft">{`${r.protectionsOff} off`}</Badge>,
      danger: (r) => r.protectionsOff > 0,
    },
    {
      key: 'alert', label: 'ALERT',
      title: tt('ALERT 로그 미설정이면 위협 탐지 이벤트를 볼 수 없음'),
      value: (r) => (!r.loggingKnown ? null : r.alertLogging ? 'on' : 'off'),
      render: (r) => logCell(r, r.alertLogging),
      danger: (r) => r.loggingKnown && r.alertLogging == null,
    },
  ], [tt, logCell]);

  const policyColumns = useMemo<MetricCol<AnfwPolicyRow>[]>(() => [
    {
      key: 'name', label: 'Policy', mono: true,
      title: tt('stateless 기본 액션이 aws:pass인 정책은 빨간색 — 매치 안 된 트래픽이 검사 없이 통과'),
      value: (r) => r.name,
      danger: (r) => r.passthroughDefault,
    },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    { key: 'status', label: 'State', facet: true, value: (r) => r.status },
    {
      key: 'assoc', label: tt('연결 수'), type: 'num',
      title: tt('이 정책을 사용하는 방화벽 수 — 0이면 미사용 정책'),
      value: (r) => r.associations,
      render: (r) => (r.associations === 0 ? <Badge variant="outline">{tt('미사용')}</Badge> : String(r.associations)),
    },
    { key: 'slg', label: 'Stateless RG', type: 'num', value: (r) => r.statelessGroups.length },
    { key: 'sfg', label: 'Stateful RG', type: 'num', value: (r) => r.statefulGroups.length },
    {
      key: 'sldef', label: tt('기본 액션'),
      title: tt('StatelessDefaultActions — aws:forward_to_sfe가 정상 경로, aws:pass는 스테이트풀 우회 (fragment 기본이 aws:pass면 병기)'),
      // fragment 기본만 aws:pass인 경우 — 위험 원인이 셀에 보이도록 병기 (danger 기준과 표시 일치)
      value: (r) => {
        const fragPass = r.statelessFragmentDefaultActions.includes('aws:pass');
        return (r.statelessDefaultActions.join(',') + (fragPass ? ' frag:aws:pass' : '')) || null;
      },
      render: (r) => {
        const fragPass = r.statelessFragmentDefaultActions.includes('aws:pass');
        const text = r.statelessDefaultActions.join(', ') + (fragPass ? ' (frag: aws:pass)' : '');
        return text === ''
          ? dash
          : r.passthroughDefault
            ? <Badge tone="negative" variant="soft">{text}</Badge>
            : <span className="font-mono text-[12px]">{text}</span>;
      },
      danger: (r) => r.passthroughDefault,
    },
    {
      key: 'capsl', label: tt('용량 SL'), type: 'num',
      title: tt('소비한 stateless 룰 용량'),
      value: (r) => r.consumedStatelessCapacity,
    },
    {
      key: 'capsf', label: tt('용량 SF'), type: 'num',
      title: tt('소비한 stateful 룰 용량'),
      value: (r) => r.consumedStatefulCapacity,
    },
    {
      key: 'modified', label: tt('수정 시각'), type: 'num',
      value: (r) => (r.lastModified ? Date.parse(r.lastModified) : null),
      render: (r) => (r.lastModified ? r.lastModified.replace('T', ' ').slice(0, 19) : dash),
    },
  ], [tt]);

  const rgColumns = useMemo<MetricCol<AnfwRuleGroupRow>[]>(() => [
    {
      key: 'name', label: 'Rule Group', mono: true,
      title: tt('용량 80% 이상인 룰 그룹은 빨간색 — 룰 추가가 곧 막힘'),
      value: (r) => r.name,
      danger: (r) => (r.capacityPct ?? 0) >= 80,
    },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    { key: 'type', label: 'Type', facet: true, value: (r) => r.type },
    { key: 'status', label: 'State', facet: true, value: (r) => r.status },
    {
      key: 'cap', label: tt('용량 사용률'), type: 'num',
      title: tt('소비 용량 ÷ 총 용량 — 생성 후 변경 불가라 80% 이상이면 재생성 계획 필요'),
      value: (r) => r.capacityPct,
      render: (r) => (r.capacityPct == null ? dash : `${r.capacityPct}%`),
      danger: (r) => (r.capacityPct ?? 0) >= 80,
    },
    {
      key: 'consumed', label: tt('소비/총'),
      value: (r) => (r.consumedCapacity == null || r.capacity == null ? null : `${r.consumedCapacity}/${r.capacity}`),
      render: (r) => (r.consumedCapacity == null || r.capacity == null ? dash : `${r.consumedCapacity} / ${r.capacity}`),
    },
    {
      key: 'assoc', label: tt('연결 수'), type: 'num',
      title: tt('이 룰 그룹을 참조하는 정책 수 — 0이면 정리 후보'),
      value: (r) => r.associations,
      render: (r) => (r.unassociated ? <Badge variant="outline">{tt('미연결')}</Badge> : String(r.associations)),
    },
    {
      key: 'modified', label: tt('수정 시각'), type: 'num',
      value: (r) => (r.lastModified ? Date.parse(r.lastModified) : null),
      render: (r) => (r.lastModified ? r.lastModified.replace('T', ' ').slice(0, 19) : dash),
    },
  ], [tt]);

  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Network Firewall"
        subtitle="방화벽·정책·룰 그룹 인벤토리 + AWS/NetworkFirewall 메트릭 트래픽·드롭 집계 — 보호 설정·로깅 갭·전량 통과 기본 액션·룰 용량 분석"
        right={<RangePicker value={range} onChange={setRange} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="text-[13px] text-rose-600">{tt('Network Firewall 조회 실패')}: {err}</div>
        )}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {data && (data.degradedRegions.length > 0 || data.metricsDegradedRegions.length > 0) && (
          <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-[12px] text-warning-text">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {data.degradedRegions.length > 0 && (
                <>{tt('일부 리전 조회 실패')} ({data.degradedRegions.join(', ')}) — {tt('해당 리전의 방화벽·정책·룰 그룹이 누락되거나 실제보다 적게 집계되어 보호·로깅·트래픽·용량 분석이 실제보다 낙관적일 수 있습니다.')} </>
              )}
              {data.metricsDegradedRegions.length > 0 && (
                <>{tt('일부 리전 메트릭 조회 실패')} ({data.metricsDegradedRegions.join(', ')}) — {tt('해당 리전은 CloudWatch 미순회·용량 캡·쿼리 실패로 트래픽·드롭 수치가 실제보다 적을 수 있습니다.')}</>
              )}
            </span>
          </div>
        )}

        {data && t && (() => {
          // 리전 통째 누락(degradedRegions)이 있으면 모든 카운트/합계가 하한이다 —
          // "0건"·"이상 없음"을 확정값처럼 보여주면 실제보다 낙관적인 오탐이 된다.
          const resourcesDegraded = data.degradedRegions.length > 0;
          const metricsDegraded = data.metricsDegradedRegions.length > 0;
          // 트래픽/드롭 수치는 방화벽 자체가 누락됐을 때(resourcesDegraded)뿐 아니라
          // CloudWatch만 저하됐을 때(metricsDegraded)도 실제보다 적게 나올 수 있다.
          const trafficDegraded = resourcesDegraded || metricsDegraded;
          // loggingKnown===false(로깅 구성 조회 자체가 거부됨)인 방화벽이 하나라도 있으면
          // "모든 방화벽 이상 없음"을 주장할 수 없다 — 그 방화벽의 실제 로깅 상태를 모른다
          // (리뷰 MAJOR: per-row는 "확인 불가"를 정직하게 표시하면서 요약 카드만 초록 단정).
          const loggingUnverifiable = t.loggingUnknownFirewalls > 0;
          const lb = (n: number) => (resourcesDegraded ? `${n}+` : String(n));
          const degradedHint = tt('일부 리전 조회 실패 — 실제보다 적을 수 있음');
          const metricsDegradedHint = tt('일부 리전 메트릭 조회 실패 — 실제보다 적을 수 있음');
          // 원래 힌트를 지우지 않고 뒤에 붙인다 — 저하됐다고 실측 카운트를 숨기면
          // 그 자체가 또 다른 형태의 오정보가 된다.
          const withDegradedNote = (hint: string) => (resourcesDegraded ? `${hint} · ${degradedHint}` : hint);
          const withTrafficDegradedNote = (hint: string) => {
            const notes = [resourcesDegraded && degradedHint, metricsDegraded && metricsDegradedHint].filter(Boolean);
            return notes.length ? `${hint} · ${notes.join(' · ')}` : hint;
          };
          const droppedStr = fmtCount(t.droppedPackets);
          return (
          <>
            {/* ① KPI — 다운/보호 off/ALERT 갭/전량 통과 정책이 경고 축 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatTile
                label="방화벽"
                value={lb(t.firewalls)}
                variant={resourcesDegraded ? 'warn' : 'default'}
                hint={withDegradedNote(`${tt('엔드포인트')} ${t.endpoints}`)}
                icon={<Flame size={16} />}
              />
              <StatTile
                label="다운 감지"
                value={lb(t.firewallsDown)}
                variant={kpiVariant(t.firewallsDown > 0, resourcesDegraded)}
                hint={withDegradedNote(`${tt('엔드포인트 미준비')} ${t.endpointsNotReady}`)}
                icon={<Unplug size={16} />}
              />
              <StatTile
                label="정책"
                value={lb(t.policies)}
                variant={kpiVariant(t.policiesPassthrough > 0, resourcesDegraded)}
                hint={withDegradedNote(`${tt('전량 통과 기본')} ${t.policiesPassthrough}`)}
                icon={<Scroll size={16} />}
              />
              <StatTile
                label="룰 그룹"
                value={lb(t.ruleGroups)}
                variant={warnVariant(t.ruleGroupsHighCapacity > 0, resourcesDegraded)}
                hint={withDegradedNote(`${tt('미연결')} ${t.ruleGroupsUnassociated} · ${tt('용량 80%+')} ${t.ruleGroupsHighCapacity}`)}
                icon={<Layers size={16} />}
              />
              <StatTile
                label="보호 미설정"
                value={lb(t.protectionsOffFirewalls)}
                variant={warnVariant(t.protectionsOffFirewalls > 0, resourcesDegraded)}
                hint={withDegradedNote(tt('삭제/서브넷/정책 변경 보호'))}
                icon={<ShieldAlert size={16} />}
              />
              <StatTile
                label="드롭 패킷"
                value={droppedStr == null ? '—' : trafficDegraded ? `≥ ${droppedStr}` : droppedStr}
                variant={droppedStr != null && trafficDegraded ? 'warn' : 'default'}
                hint={withTrafficDegradedNote(`${tt('거부')} ${fmtCount(t.rejectedPackets) ?? '—'} · ${tt('통과')} ${fmtCount(t.passedPackets) ?? '—'}`)}
                icon={<Shield size={16} />}
              />
            </div>

            {/* ② 분포 — 룰 그룹 타입 도넛 + 용량 사용률 바 */}
            <div className="grid gap-6 lg:grid-cols-2">
              <DonutBreakdown title="룰 그룹 타입 분포" data={rgTypeDist} nameKey="name" valueKey="value" />
              <HBarList title="룰 그룹 용량 사용률 (%)" data={rgCapacity} labelKey="rg" valueKey="pct" highlightMax />
            </div>

            {/* ③ 방화벽 점검 — 보호 설정 off / ALERT 로깅 미설정 방화벽 */}
            <Card
              title="방화벽 점검"
              subtitle="보호 설정(삭제·서브넷·정책 변경)과 ALERT 로깅이 꺼진 방화벽"
              padded={false}
            >
              {fws.length === 0 && !resourcesDegraded ? (
                <div className="px-4 py-3 text-[13px] text-ink-400">{tt('방화벽 없음')}</div>
              ) : issueFws.length === 0 ? (
                resourcesDegraded || loggingUnverifiable ? (
                  // 리전이 통째로 빠졌거나(resourcesDegraded), 점검한 방화벽은 전부 정상이지만
                  // 일부 방화벽의 로깅 구성 조회 자체가 거부돼(loggingUnverifiable) 그 방화벽들의
                  // 실제 로깅 상태를 모르는 상태다 — 어느 쪽이든 "이상 없음"을 확정할 수 없다.
                  <div className="flex items-start gap-2 px-4 py-3 text-[13px] text-warning-text">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    <span>
                      {resourcesDegraded && (
                        <>{tt('일부 리전 조회 실패로 점검 결과를 신뢰할 수 없습니다')} ({data.degradedRegions.join(', ')}) </>
                      )}
                      {loggingUnverifiable && (
                        <>{tt('일부 방화벽의 로깅 구성 조회가 거부되어 점검 결과를 신뢰할 수 없습니다')} ({t.loggingUnknownFirewalls})</>
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-emerald-700">
                    <CheckCircle2 size={15} />
                    {tt('이상 없음 — 모든 방화벽에 보호 설정과 ALERT 로깅이 켜져 있습니다')}
                  </div>
                )
              ) : (
                <>
                  <div className="px-4 pt-3 text-[12px] text-ink-500">
                    {tt('보호 설정이 꺼진 방화벽은 실수로 삭제·변경될 수 있고, ALERT 로그가 없으면 룰이 잡은 위협을 볼 수 없습니다')}
                    {resourcesDegraded && (
                      <> · {tt('일부 리전 조회 실패로 이 목록은 실제보다 짧을 수 있습니다')} ({data.degradedRegions.join(', ')})</>
                    )}
                    {loggingUnverifiable && (
                      <> · {tt('일부 방화벽의 로깅 구성 조회가 거부되어 점검 결과를 신뢰할 수 없습니다')} ({t.loggingUnknownFirewalls})</>
                    )}
                  </div>
                  <div className="overflow-x-auto pb-2">
                    <table className="w-full">
                      <thead><tr className="border-b border-ink-100">
                        <th className={TH}>Firewall</th>
                        <th className={TH}>{tt('삭제 보호')}</th>
                        <th className={TH}>{tt('서브넷 변경 보호')}</th>
                        <th className={TH}>{tt('정책 변경 보호')}</th>
                        <th className={TH}>ALERT</th>
                        <th className={TH}>FLOW</th>
                      </tr></thead>
                      <tbody>
                        {issueFws.map((f) => (
                          <tr
                            key={`${f.region}|${f.name}`}
                            onClick={() => setSelected({ kind: 'fw', row: f })}
                            className="cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50"
                          >
                            <td className={MONO}>{f.name}</td>
                            <td className={TD}>{f.deleteProtection ? onMark : offBadge}</td>
                            <td className={TD}>{f.subnetChangeProtection ? onMark : offBadge}</td>
                            <td className={TD}>{f.policyChangeProtection ? onMark : offBadge}</td>
                            <td className={TD}>{logCell(f, f.alertLogging)}</td>
                            <td className={TD}>{logCell(f, f.flowLogging)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {/* owner 제공 모니터링 계층 가이드 — 지표/로그/보완 소스 + 목적별 우선순위 */}
              <DiagnosisGuide spec={ANFW_GUIDE} />
            </Card>

            {/* ④ 방화벽 — 상태/동기화/트래픽, 행 클릭 → 상세 */}
            <Card
              title="방화벽"
              subtitle="행 클릭 → 엔드포인트·보호·로깅·트래픽 상세"
              padded={false}
            >
              <MetricTable
                columns={fwColumns}
                items={fws}
                rowKey={(r) => `${r.region}|${r.name}`}
                emptyText="방화벽 없음"
                onRowClick={(r) => setSelected({ kind: 'fw', row: r })}
              />
            </Card>

            {/* ⑤ 방화벽 정책 — 기본 액션/룰 그룹 참조/용량 */}
            <Card
              title="방화벽 정책"
              subtitle="행 클릭 → 룰 그룹·기본 액션 상세"
              padded={false}
            >
              <MetricTable
                columns={policyColumns}
                items={policies}
                rowKey={(r) => `${r.region}|${r.name}`}
                emptyText="정책 없음"
                onRowClick={(r) => setSelected({ kind: 'policy', row: r })}
              />
            </Card>

            {/* ⑥ 룰 그룹 — 용량 사용률·미연결 */}
            <Card
              title="룰 그룹"
              subtitle="행 클릭 → 용량 상세 (룰 본문은 표시하지 않음)"
              padded={false}
            >
              <MetricTable
                columns={rgColumns}
                items={rgs}
                rowKey={(r) => `${r.region}|${r.type}|${r.name}`}
                emptyText="룰 그룹 없음"
                onRowClick={(r) => setSelected({ kind: 'rg', row: r })}
              />
            </Card>

            {/* ⑦ Alert 로그 분석 — stateful alert/drop 매칭 (Logs Insights, CWL 대상만) */}
            <Card
              title="Alert 로그 분석 · Stateful 룰 히트 카운트"
              subtitle="어떤 규칙(sid)이 얼마나 매칭됐는지 — Alert 로그 Insights 집계 (AWS 룰 히트 카운트 기능과 동일 소스), 설정 룰과 조인해 매칭 없는 룰 표면화"
              padded={false}
            >
              {logsErr && <div className="px-4 py-3 text-[13px] text-rose-600">{tt('로그 분석 실패')}: {logsErr}</div>}
              {!logsData && !logsErr && <div className="px-4 py-3 text-[13px] text-ink-400">{tt('로그 집계 중… (Logs Insights)')}</div>}
              {logsData && (
                <>
                  {(logsData.targets.some((t) => t.discovered) || logsData.unsupportedDestinations > 0) && (
                    <div className="px-4 pt-3 text-[12px] text-ink-500">
                      {logsData.targets.some((t) => t.discovered) && <span>{tt('로깅 구성 조회가 거부되어 관례 접두사(/aws/network-firewall)로 로그 그룹을 발견했습니다')} </span>}
                      {logsData.unsupportedDestinations > 0 && <span>{tt('S3/Firehose 대상 로그는 이 화면에서 집계할 수 없습니다 (Athena 등 별도 분석)')}</span>}
                    </div>
                  )}
                  {logsData.failed.length > 0 && (
                    // 리뷰 MAJOR: 이 배열이 이전엔 어디에도 렌더링되지 않아, 로그 그룹 조회가
                    // 전부 실패해도 화면은 "정상 0건"과 똑같이 보였다 — 실패한 집계 키를 그대로 노출.
                    <div className="flex items-start gap-2 px-4 pt-3 text-[12px] text-warning-text">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{tt('일부 로그 그룹 조회 실패')} ({logsData.failed.join(', ')}) — {tt('해당 집계는 실제보다 적을 수 있습니다.')}</span>
                    </div>
                  )}
                  {logsData.alert == null ? (
                    <div className="px-4 py-3 text-[13px] text-ink-400">
                      {/* Flow 카드와 동일하게 발견 실패(firewallDiscovery/logDiscovery/
                          logDiscoveryEmpty:*:ALERT)는 "로그 없음"이 아니라 "확인 불가"로
                          구분 표시. 리뷰 MAJOR(라운드12): logDiscoveryEmpty는 이제 타입별
                          키(:ALERT/:FLOW)라 이 카드는 자기 타입 키만 봐야 한다 — FLOW만
                          unknown인 리전을 ALERT 카드가 잘못 "확인 불가"로 표시하면 안 됨. */}
                      {logsData.failed.some((k) => k === 'firewallDiscovery' || k === 'logDiscovery' || k.startsWith('logDiscoveryEmpty:') && k.endsWith(':ALERT'))
                        ? tt('확인 불가 (로깅 구성 조회 실패 — ALERT 로그 유무 미확인)')
                        : tt('CloudWatch Logs 대상 ALERT 로그 없음')}
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                        {/* 리뷰 MAJOR(라운드10): totalAlerts는 조회 실패 시 null(0과 구분) —
                            그대로 0으로 렌더링하면 "조회 실패"가 "알럿 0건"처럼 보인다. */}
                        <span className="font-semibold">{tt('알럿')} {logsData.alert.totalAlerts == null ? tt('확인 불가') : logsData.alert.totalAlerts.toLocaleString()}</span>
                        {logsData.alert.byAction.map((a) => (
                          <Badge key={a.name} tone={a.name === 'blocked' ? 'negative' : 'neutral'} variant="soft">
                            {`${a.name} ${a.value.toLocaleString()}`}
                          </Badge>
                        ))}
                        <span>{tt('설정 stateful 룰')} {ruleHitRows.filter((r) => r.configured).length}</span>
                        {idleConfiguredRules > 0 && (
                          <Badge tone="negative" variant="soft">{tt('매칭 없는 설정 룰')} {idleConfiguredRules}</Badge>
                        )}
                      </div>
                      {/* 리뷰 MAJOR(확정, PR #225 라운드3): ruleHits가 null(쿼리 실패/discovery unknown)이고
                          룰 그룹 자체도 비어 있으면(Describe 실패 등) ruleHitRows가 완전히 비어 이
                          카드에서 "어떤 SID가 있었는지" 정보 자체가 사라진다. topSignatures는 이
                          경로들과 독립적으로 채워지므로(alertTotals/ruleHits 실패와 무관), ruleHitRows가
                          비었을 때 최소한의 SID 표면(설정 룰과 조인 없는 원시 Top 시그니처)으로 폴백한다. */}
                      {ruleHitRows.length === 0 && (logsData.alert.topSignatures.length > 0) && (
                        <>
                          <div className="px-4 text-[12px] font-medium text-ink-600">{tt('Top 시그니처 (룰 그룹 정보 없음)')}</div>
                          <div className="px-4 pb-1 text-[12px] text-ink-500">
                            {tt('설정 룰과 조인할 수 없어 히트 카운트 대신 원시 Alert 시그니처만 표시합니다')}
                          </div>
                          <div className="overflow-x-auto px-4 pb-3">
                            <table className="w-full">
                              <thead><tr className="border-b border-ink-100">
                                <th className={TH}>SID</th>
                                <th className={TH}>Signature</th>
                                <th className={TH}>{tt('건수')}</th>
                              </tr></thead>
                              <tbody>
                                {logsData.alert.topSignatures.map((s) => (
                                  <tr key={`${s.sid}|${s.signature}`} className="border-b border-ink-50 last:border-0">
                                    <td className={MONO}>{s.sid}</td>
                                    <td className={TD}>{s.signature || dash}</td>
                                    <td className={TD}>{s.value.toLocaleString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                      {ruleHitRows.length > 0 && (
                        <>
                          <div className="px-4 text-[12px] font-medium text-ink-600">{tt('Stateful 룰 히트 카운트')}</div>
                          <div className="px-4 pb-1 text-[12px] text-ink-500">
                            {tt('Alert 로그 집계 기반 — pass 룰은 Alert 로그를 남기지 않아 집계할 수 없습니다 (매칭 없음으로 세지 않음)')}
                          </div>
                          {ruleHitRows.length > 50 && (
                            <div className="px-4 pb-1 text-[12px] text-ink-500">{tt('히트 상위 50행 + 매칭 없는 설정 룰만 표시 (나머지 생략)')}</div>
                          )}
                          <div className="overflow-x-auto px-4 pb-3">
                            <table className="w-full">
                              <thead><tr className="border-b border-ink-100">
                                <th className={TH}>SID</th>
                                <th className={TH}>Msg / Signature</th>
                                <th className={TH}>Action</th>
                                <th className={TH}>{tt('룰 그룹')}</th>
                                <th className={TH}>{tt('히트')}</th>
                              </tr></thead>
                              <tbody>
                                {ruleHitRows
                                  .filter((r, i) => i < 50 || (r.configured && !r.isPass && r.observability === 'observed' && !r.sharedSid && !r.unknown && r.hits === 0))
                                  .map((r) => (
                                  <tr key={r.key} className={`border-b border-ink-50 last:border-0 ${r.configured && !r.isPass && r.observability === 'observed' && !r.sharedSid && !r.unknown && r.hits === 0 ? 'opacity-60' : ''}`}>
                                    <td className={MONO}>{r.sid}{r.sharedSid && <span className="ml-1 text-ink-400" title={tt('여러 룰 그룹이 같은 SID 사용 — Alert 로그는 룰 그룹을 식별하지 못해 히트를 그룹별로 귀속할 수 없음')}>*</span>}</td>
                                    <td className={TD}>{r.msg || dash}</td>
                                    <td className={MONO}>{r.actions.join(', ') || dash}</td>
                                    <td className={MONO}>{r.ruleGroups.join(', ') || <span title={tt('룰 그룹에서 SID를 찾지 못함 (관리형 룰 그룹 등)')}>{dash}</span>}</td>
                                    <td className={`${TD} ${r.observability === 'observed' && !r.sharedSid && r.hits > 0 && r.actions.includes('blocked') ? DANGER : ''}`}>
                                      {r.isPass
                                        ? <span className="text-ink-300" title={tt('pass 룰 — Alert 로그 미발생')}>n/a</span>
                                        // 리뷰 확정(codex stop-hook + PR #225 라운드3): hits===0일 때만 미관측
                                        // 처리하면, 관측 불가한 룰 그룹이라도 공유 SID로 우연히 집계된 0 초과
                                        // 히트가 그대로 표시되어 실제로 볼 수 없는 트래픽이 이 룰에 귀속된
                                        // 것처럼 오독된다 — hits 값과 무관하게 관측/공유 여부를 먼저 확인한다.
                                        // sharedSid(같은 sid를 쓰는 룰 그룹이 2개 이상)도 동일하게 숫자를
                                        // 숨긴다 — 그룹별 귀속이 근본적으로 불가능한 숫자를 그룹별 행에
                                        // 노출하면 CLAUDE.md가 문서화한 "귀속 불가는 표시만, 집계 안 함"
                                        // 계약을 어긴다.
                                        : r.observability === 'unobserved' || r.sharedSid
                                          ? <span className="text-ink-300" title={tt(r.sharedSid ? '여러 룰 그룹이 같은 SID 사용 — 어느 그룹의 히트인지 알 수 없어 숫자를 표시하지 않습니다' : '관측 불가 룰 그룹 — 트래픽에 매칭될 수 없음 (표시되는 히트가 있어도 이 룰 귀속으로 볼 수 없음)')}>n/a</span>
                                          : r.unknown
                                            ? <span className="text-ink-300" title={tt(r.unknownReason === 'failed' ? '로그 집계 쿼리 실패 — 매칭 여부 불명' : '상위 100 집계 밖 — 매칭 여부 불명')}>?</span>
                                            // 리뷰 확정(Codex stop-hook, PR #225): hits===0일 때만 불확실 처리하면
                                            // hits>0인 경우엔 그대로 숫자를 보여줬다 — 하지만 observability가
                                            // 'unknown'인 리전은 정책/방화벽 목록 자체가 불완전할 수 있어
                                            // (data.degradedRegions), 놓친 형제 룰 그룹이 같은 sid를 쓰고 있을
                                            // 가능성도 확인할 수 없다(sidGroupCount가 완전한 rgs 순회를 전제).
                                            // 0이든 양수든 이 룰에 확정 귀속할 수 없으므로 값과 무관하게 불명 처리.
                                            : r.observability === 'unknown'
                                              ? <span className="text-ink-300" title={tt('이 리전의 정책/방화벽 데이터가 불완전해 매칭 여부·귀속을 확정할 수 없음')}>?</span>
                                              : r.hits.toLocaleString()}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                      {/* 리뷰 MAJOR(라운드10, stop-hook 재수정): totalAlerts>0 게이트를 단일 조건으로
                          바꿨더니, 한쪽 표만 실패해도 성공한 다른 표까지 가려지는 동일 계급의
                          버그가 자리만 옮겼다 — 이 표는 자기 데이터 유무로 독립 게이트한다. */}
                      {(logsData.alert.topSources.length > 0 || logsData.alert.topDests.length > 0) && (
                        <div className="grid gap-4 px-4 pb-3">
                          <div className="overflow-x-auto">
                            <table className="w-full">
                              <thead><tr className="border-b border-ink-100">
                                <th className={TH}>{tt('소스 IP')}</th>
                                <th className={TH}>{tt('건수')}</th>
                                <th className={TH}>{tt('목적지')}</th>
                                <th className={TH}>{tt('건수')}</th>
                              </tr></thead>
                              <tbody>
                                {Array.from({ length: Math.max(logsData.alert.topSources.length, logsData.alert.topDests.length) }).map((_, i) => (
                                  <tr key={i} className="border-b border-ink-50 last:border-0">
                                    <td className={MONO}>{logsData.alert?.topSources[i]?.name ?? ''}</td>
                                    <td className={TD}>{logsData.alert?.topSources[i]?.value.toLocaleString() ?? ''}</td>
                                    <td className={MONO}>{logsData.alert?.topDests[i]?.name ?? ''}</td>
                                    <td className={TD}>{logsData.alert?.topDests[i]?.value.toLocaleString() ?? ''}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </Card>

            {/* ⑧ Flow 로그 분석 — stateful 엔진이 본 플로우, Top talker */}
            <Card
              title="Flow 로그 분석"
              subtitle="Stateful 엔진이 본 플로우(5-tuple·바이트) — Top talker와 프로토콜 분포"
              padded={false}
            >
              {logsErr && <div className="px-4 py-3 text-[13px] text-rose-600">{tt('로그 분석 실패')}: {logsErr}</div>}
              {!logsData && !logsErr && <div className="px-4 py-3 text-[13px] text-ink-400">{tt('로그 집계 중… (Logs Insights)')}</div>}
              {/* 리뷰 MAJOR(라운드10): 이 카드에는 failed[] 배너가 없어, resolveTargets가
                  degrade(firewallDiscovery/logDiscovery*)돼 200으로 응답이 와도 "FLOW 로그
                  없음"이 확정 부재처럼 보였다 — Alert 카드와 동일하게 배너를 렌더링. */}
              {logsData && logsData.failed.length > 0 && (
                <div className="flex items-start gap-2 px-4 pt-3 text-[12px] text-warning-text">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{tt('일부 로그 그룹 조회 실패')} ({logsData.failed.join(', ')}) — {tt('해당 집계는 실제보다 적을 수 있습니다.')}</span>
                </div>
              )}
              {logsData && (logsData.flow == null ? (
                <div className="px-4 py-3 text-[13px] text-ink-400">
                  {/* 리뷰 MAJOR(라운드12): logDiscoveryEmpty가 타입별 키가 됐으므로 이
                      카드는 자기 타입(:FLOW) 키만 봐야 한다 — ALERT만 unknown인 리전을
                      이 카드가 잘못 "확인 불가"로 표시하면 안 됨. */}
                  {logsData.failed.some((k) => k === 'firewallDiscovery' || k === 'logDiscovery' || k.startsWith('logDiscoveryEmpty:') && k.endsWith(':FLOW'))
                    ? tt('확인 불가 (로깅 구성 조회 실패 — FLOW 로그 유무 미확인)')
                    : tt('CloudWatch Logs 대상 FLOW 로그 없음')}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                    {/* 리뷰 MAJOR(라운드11): flowTotals 실패 시 totalFlows/totalBytes는 null —
                        alert 카드와 동일하게 "확인 불가"로 표시(0건과 구분). 아래 표는 이미
                        topTalkers.length로 독립 게이트돼 있어 totals 실패의 영향을 받지 않음. */}
                    <span className="font-semibold">{tt('플로우')} {logsData.flow.totalFlows == null ? tt('확인 불가') : logsData.flow.totalFlows.toLocaleString()}</span>
                    <span>{tt('전송량')} {fmtBytes(logsData.flow.totalBytes) ?? dash}</span>
                    {logsData.flow.byProto.map((p) => (
                      <Badge key={p.name} variant="outline" mono>{`${p.name} ${p.value.toLocaleString()}`}</Badge>
                    ))}
                  </div>
                  {logsData.flow.talkersWindowSec < logsData.rangeSec && (
                    <div className="px-4 pb-1 text-[12px] text-ink-500">
                      {tt('Top talker는 최근 6시간 창 기준 — 플로우 볼륨이 커서 전체 범위 집계는 시간 초과')}
                    </div>
                  )}
                  {logsData.flow.topTalkers.length > 0 && (
                    <div className="overflow-x-auto pb-2">
                      <table className="w-full">
                        <thead><tr className="border-b border-ink-100">
                          <th className={TH}>{tt('소스')}</th>
                          <th className={TH}>{tt('목적지')}</th>
                          <th className={TH}>{tt('전송량')}</th>
                          <th className={TH}>{tt('플로우')}</th>
                        </tr></thead>
                        <tbody>
                          {logsData.flow.topTalkers.map((t2) => (
                            <tr key={`${t2.src}|${t2.dst}`} className="border-b border-ink-50 last:border-0">
                              <td className={MONO}>{t2.src}</td>
                              <td className={MONO}>{t2.dst}</td>
                              <td className={TD}>{fmtBytes(t2.bytes) ?? dash}</td>
                              <td className={TD}>{t2.flows.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ))}
            </Card>

            {/* ⑧-b Flow 시각화 — 프로토콜 분포 도넛 + Top talker 전송량 바 */}
            {/* 리뷰 MAJOR(라운드11): totalFlows>0 게이트는 flowTotals만 실패해도(byProto/
                topTalkers 쿼리는 성공) 이미 로드된 차트 두 개를 통째로 숨겼다 — 두 차트가
                실제로 그릴 데이터 유무로 게이트를 교체(totalFlows는 위 카드에서 별도 표시). */}
            {logsData?.flow != null && (logsData.flow.byProto.length > 0 || logsData.flow.topTalkers.length > 0) && (
              <div className="grid gap-6 lg:grid-cols-2">
                <DonutBreakdown title="Flow 프로토콜 분포" data={flowProtoDist} nameKey="name" valueKey="value" />
                <HBarList title="Top talker 전송량 (MB)" data={talkerBars} labelKey="pair" valueKey="mb" highlightMax />
              </div>
            )}

            {/* ⑨ 구성 변경 감사 — CloudTrail 변경(mutation) 이벤트만 계정 전체에서 조회한 뒤
                클라이언트에서 NFW EventSource로 필터(라운드8: EventSource 단위 조회는 이 앱
                자신의 read 이벤트가 목록을 가득 채워 실제 변경 이벤트가 90일치가 아니라
                최근 몇 시간분만 보이는 문제가 있었음 — ReadOnly=false 필터로 전환) */}
            <Card
              title="구성 변경 감사"
              subtitle="CloudTrail 변경 이벤트 — 누가 방화벽/정책/룰을 바꿨는지 (조회 범위 90일, 전체 최근 50건까지)"
              padded={false}
            >
              {auditErr && <div className="px-4 py-3 text-[13px] text-rose-600">{tt('감사 이벤트 조회 실패')}: {auditErr}</div>}
              {!audit && !auditErr && <div className="px-4 py-3 text-[13px] text-ink-400">{tt('로딩 중…')}</div>}
              {audit && auditDegradedRegions.length > 0 && (
                // 리뷰 MAJOR: 이벤트명 단위 CloudTrail 조회가 일부 실패해도 조용히 삼키면
                // "조회 범위 내 변경 없음"과 "조회 자체가 실패함"을 구분할 수 없다 —
                // 감사(audit) 화면에서 가장 나쁜 오류 형태이므로 항상 배너로 노출한다.
                <div className="flex items-start gap-2 px-4 pt-3 text-[12px] text-warning-text">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{tt('일부 리전 조회 실패')} ({auditDegradedRegions.join(', ')}) — {tt('해당 리전은 변경 이벤트 조회 자체가 실패해 "변경 없음"을 확정할 수 없습니다.')}</span>
                </div>
              )}
              {audit && (audit.length === 0 ? (
                auditDegradedRegions.length > 0 ? (
                  <div className="px-4 py-3 text-[13px] text-ink-400">{tt('조회 실패로 변경 이벤트 유무를 확인할 수 없습니다')}</div>
                ) : (
                  <div className="px-4 py-3 text-[13px] text-ink-400">{tt('조회 범위(90일) 내 변경 이벤트 없음')}</div>
                )
              ) : (
                <div className="overflow-x-auto pb-2">
                  <table className="w-full">
                    <thead><tr className="border-b border-ink-100">
                      <th className={TH}>{tt('시각')}</th>
                      <th className={TH}>{tt('이벤트')}</th>
                      <th className={TH}>{tt('사용자')}</th>
                      <th className={TH}>{tt('리소스')}</th>
                      <th className={TH}>{tt('리전')}</th>
                    </tr></thead>
                    <tbody>
                      {audit.map((e, i) => (
                        <tr key={`${e.time}|${e.name}|${i}`} className="border-b border-ink-50 last:border-0">
                          <td className={TD}>{e.time.replace('T', ' ').slice(0, 19)}</td>
                          <td className={MONO}>{e.name}</td>
                          <td className={TD}>{e.user || dash}</td>
                          <td className={MONO}>{e.resourceName || dash}</td>
                          <td className={TD}>{e.region}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </Card>
          </>
          );
        })()}
      </div>

      <DetailPanel
        title={selected?.row.name}
        data={selected
          ? selected.kind === 'fw'
            ? fwDetail(selected.row)
            : selected.kind === 'policy'
              ? policyDetail(selected.row)
              : rgDetail(selected.row)
          : null}
        spec={selected?.kind === 'fw' ? FW_DETAIL_SPEC : selected?.kind === 'policy' ? POLICY_DETAIL_SPEC : RG_DETAIL_SPEC}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
