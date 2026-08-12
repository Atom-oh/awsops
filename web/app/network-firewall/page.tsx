'use client';
import { useEffect, useMemo, useState } from 'react';
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
import { useI18n } from '@/components/shell/LanguageProvider';
import type { AnfwAnalysis, AnfwFirewallRow, AnfwPolicyRow, AnfwRuleGroupRow } from '@/lib/anfw';
import type { InvType } from '@/lib/inventory-types';

// /network-firewall — AWS Network Firewall 리스트+분석 (Network 메뉴). 방화벽/정책/룰 그룹을
// 리전 fan-out으로 수집하고 AWS/NetworkFirewall 메트릭(기간 Sum)으로 트래픽·드롭을 집계한다.
// 분석 렌즈: 보호 설정 off(변경·삭제 사고 노출) · ALERT 로깅 갭(위협 가시성 없음) ·
// stateless 기본 aws:pass(스테이트풀 엔진 우회) · 룰 그룹 용량(≥80%)·미연결(정리 후보) ·
// 엔드포인트/동기화 이상. 데이터 계층은 lib/anfw.ts(4분 TTL 캐시).

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
    { key: 'drop_rate_pct', label: 'Drop Rate %' }, { key: 'az_engine_metrics', label: 'Per AZ / Engine' },
  ],
  sections: [
    { label: 'Identity', keys: ['name', 'region', 'vpc_id', 'policy_name', 'status', 'sync_summary', 'encryption_type'] },
    { label: 'Endpoints', keys: ['endpoints'] },
    { label: 'Protection', keys: ['delete_protection', 'subnet_change_protection', 'policy_change_protection'] },
    { label: 'Logging', keys: ['alert_logging', 'flow_logging', 'tls_logging'] },
    { label: 'Traffic', keys: ['received_packets', 'received_bytes', 'passed_packets', 'dropped_packets', 'rejected_packets', 'invalid_dropped', 'other_dropped', 'stream_exception_packets', 'drop_rate_pct', 'az_engine_metrics'] },
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

export default function NetworkFirewallPage() {
  const { tt } = useI18n();
  const [range, setRange] = useState(86400);
  const [data, setData] = useState<AnfwAnalysis | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => {
    let alive = true;
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

  // 점검 카드: 보호 off 또는 (조회 성공했는데) ALERT 미설정 방화벽만 나열 — "확인 불가"는 경고 아님.
  const issueFws = useMemo(() => fws.filter((f) => f.protectionsOff > 0 || (f.loggingKnown && f.alertLogging == null)), [fws]);

  const offBadge = <Badge tone="negative" variant="soft">off</Badge>;
  const onMark = <span className="text-emerald-700">on</span>;
  // 로깅 셀 3상태: on / off / 확인 불가(조회 거부 — 미설정과 구분).
  const logCell = (f: AnfwFirewallRow, dest: string | null) => !f.loggingKnown
    ? <span className="text-ink-400" title={tt('로깅 구성 조회가 거부되어 설정 여부를 알 수 없음 (미설정과 다름)')}>{tt('확인 불가')}</span>
    : dest ? onMark : offBadge;

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
      title: tt('기간 내 ReceivedPackets 합계 (AZ·엔진 합산)'),
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
  ], [tt, offBadge, onMark, logCell]);

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

        {data && data.degradedRegions.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-[12px] text-warning-text">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {tt('일부 리전 조회 실패')} ({data.degradedRegions.join(', ')}) — {tt('해당 리전의 방화벽·정책·룰 그룹이 누락되거나 실제보다 적게 집계되어 보호·로깅·트래픽·용량 분석이 실제보다 낙관적일 수 있습니다.')}
            </span>
          </div>
        )}

        {data && t && (
          <>
            {/* ① KPI — 다운/보호 off/ALERT 갭/전량 통과 정책이 경고 축 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatTile
                label="방화벽"
                value={t.firewalls}
                hint={`${tt('엔드포인트')} ${t.endpoints}`}
                icon={<Flame size={16} />}
              />
              <StatTile
                label="다운 감지"
                value={t.firewallsDown}
                variant={t.firewallsDown > 0 ? 'danger' : 'default'}
                hint={`${tt('엔드포인트 미준비')} ${t.endpointsNotReady}`}
                icon={<Unplug size={16} />}
              />
              <StatTile
                label="정책"
                value={t.policies}
                variant={t.policiesPassthrough > 0 ? 'danger' : 'default'}
                hint={`${tt('전량 통과 기본')} ${t.policiesPassthrough}`}
                icon={<Scroll size={16} />}
              />
              <StatTile
                label="룰 그룹"
                value={t.ruleGroups}
                variant={t.ruleGroupsHighCapacity > 0 ? 'warn' : 'default'}
                hint={`${tt('미연결')} ${t.ruleGroupsUnassociated} · ${tt('용량 80%+')} ${t.ruleGroupsHighCapacity}`}
                icon={<Layers size={16} />}
              />
              <StatTile
                label="보호 미설정"
                value={t.protectionsOffFirewalls}
                variant={t.protectionsOffFirewalls > 0 ? 'warn' : 'default'}
                hint="삭제/서브넷/정책 변경 보호"
                icon={<ShieldAlert size={16} />}
              />
              <StatTile
                label="드롭 패킷"
                value={fmtCount(t.droppedPackets) ?? '—'}
                hint={`${tt('거부')} ${fmtCount(t.rejectedPackets) ?? '—'} · ${tt('통과')} ${fmtCount(t.passedPackets) ?? '—'}`}
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
              {fws.length === 0 ? (
                <div className="px-4 py-3 text-[13px] text-ink-400">{tt('방화벽 없음')}</div>
              ) : issueFws.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-emerald-700">
                  <CheckCircle2 size={15} />
                  {tt('이상 없음 — 모든 방화벽에 보호 설정과 ALERT 로깅이 켜져 있습니다')}
                </div>
              ) : (
                <>
                  <div className="px-4 pt-3 text-[12px] text-ink-500">
                    {tt('보호 설정이 꺼진 방화벽은 실수로 삭제·변경될 수 있고, ALERT 로그가 없으면 룰이 잡은 위협을 볼 수 없습니다')}
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
          </>
        )}
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
