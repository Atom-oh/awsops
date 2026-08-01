'use client';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Layers, Loader2, Network, ScrollText } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { RangePicker } from '@/components/inventory/metrics/shared';
import AreaTrend from '@/components/charts/AreaTrend';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import HBarList from '@/components/charts/HBarList';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { DnsAnalytics, DnsLogConfig } from '@/lib/dns-logs';

// /dns-query — Route53 Resolver query logging 기반 DNS 쿼리 로그 분석.
// 데이터 계층은 lib/dns-logs.ts(Logs Insights 집계 + TTL 캐시)가 담당하고, 이 페이지는
// GET /api/dns-logs(상태 게이트) + GET /api/dns-logs/analytics(집계)만 소비한다.
// 쿼리 로그 설정이 없거나 CW Logs 대상이 아니면 온보딩 안내로 degrade (분석 패널 숨김).

interface StatusResp {
  configs: DnsLogConfig[];
  groups: string[];
  error?: string;
}
type AnalyticsResp = DnsAnalytics & { group: string; range: number };

// RCODE 시맨틱 색: 정상(NOERROR)은 teal, NXDOMAIN은 amber(오타/터널링 신호),
// SERVFAIL은 red(리졸버/업스트림 장애). 나머지는 positional 팔레트.
const RCODE_COLORS: Record<string, string> = {
  NOERROR: '#39C2B0', NXDOMAIN: '#F59E0B', SERVFAIL: '#D13212',
};

const ACTION_TONE: Record<string, 'negative' | 'brand' | 'positive'> = {
  BLOCK: 'negative', ALERT: 'brand', ALLOW: 'positive',
};

// Insights bin 타임스탬프("YYYY-MM-DD HH:mm:ss.SSS") → 축 라벨 (24h+는 날짜 포함).
function fmtBin(t: string, rangeSec: number): string {
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(t);
  if (!m) return t;
  return rangeSec > 86400 ? `${m[1]}/${m[2]} ${m[3]}` : m[3];
}

const SELECT_CLS = 'rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600';

type Nv = { name: string; value: number };
type SourceRow = DnsAnalytics['topSources'][number];
type FirewallRow = DnsAnalytics['firewall'][number];

export default function DnsQueryPage() {
  const { tt } = useI18n();
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [statusErr, setStatusErr] = useState('');
  const [group, setGroup] = useState('');
  const [range, setRange] = useState(3600);
  const [analytics, setAnalytics] = useState<AnalyticsResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [queryErr, setQueryErr] = useState('');

  // 상태 게이트 로드 (query-log config + CW 로그 그룹 대상 목록)
  useEffect(() => {
    let alive = true;
    fetch('/api/dns-logs')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: StatusResp) => {
        if (!alive) return;
        setStatus(d);
        if (d.groups.length) setGroup((prev) => (prev && d.groups.includes(prev) ? prev : d.groups[0]));
      })
      .catch((e) => { if (alive) setStatusErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // 로그 그룹/기간이 정해지면 자동 집계. 실패 시 이전 결과는 유지하고 에러 라인만 표시.
  useEffect(() => {
    if (!group) return;
    let alive = true;
    setBusy(true); setQueryErr('');
    fetch(`/api/dns-logs/analytics?group=${encodeURIComponent(group)}&range=${range}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as AnalyticsResp;
      })
      .then((d) => { if (alive) setAnalytics(d); })
      .catch((e) => { if (alive) setQueryErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [group, range]);

  const configs = status?.configs ?? [];
  const groups = status?.groups ?? [];
  const vpcCount = configs.reduce((s, c) => s + c.associationCount, 0);
  const createdCount = configs.filter((c) => c.status === 'CREATED').length;
  const onboarded = groups.length > 0;

  const a = analytics;
  const nxRate = a && a.totals.total > 0 ? (a.totals.nxdomain / a.totals.total) * 100 : 0;
  const nxRateLabel = `${nxRate >= 1 ? nxRate.toFixed(1) : nxRate.toFixed(2)}%`;

  const timelineData = useMemo(
    () => (a?.timeline ?? []).map((p) => ({ t: fmtBin(p.t, a?.range ?? 3600), value: p.value })),
    [a],
  );

  // ── MetricTable 컬럼 (라벨/툴팁은 tt로 번역 — MetricCol은 raw 문자열 렌더) ──
  const domainCols = useMemo<MetricCol<Nv>[]>(() => [
    { key: 'name', label: tt('도메인'), mono: true, value: (r) => r.name },
    {
      key: 'value', label: tt('쿼리 수'), type: 'num',
      value: (r) => r.value,
      render: (r) => <span className="tabular">{r.value.toLocaleString()}</span>,
    },
  ], [tt]);

  const nxTitle = tt('반복적인 NXDOMAIN 급증은 오타·잘못된 설정 또는 DNS 터널링(DGA) 활동의 신호일 수 있습니다');
  const nxCols = useMemo<MetricCol<Nv>[]>(() => [
    { key: 'name', label: tt('도메인'), mono: true, title: nxTitle, value: (r) => r.name },
    {
      key: 'value', label: tt('건수'), type: 'num', title: nxTitle,
      value: (r) => r.value,
      render: (r) => <span className="tabular">{r.value.toLocaleString()}</span>,
    },
  ], [tt, nxTitle]);

  const sourceCols = useMemo<MetricCol<SourceRow>[]>(() => [
    { key: 'srcaddr', label: tt('소스 IP'), mono: true, value: (r) => r.srcaddr },
    {
      key: 'instance', label: 'Instance', mono: true,
      title: tt('쿼리를 발생시킨 EC2 인스턴스 (srcids.instance)'),
      value: (r) => r.instance,
    },
    {
      key: 'value', label: tt('건수'), type: 'num',
      value: (r) => r.value,
      render: (r) => <span className="tabular">{r.value.toLocaleString()}</span>,
    },
  ], [tt]);

  const firewallCols = useMemo<MetricCol<FirewallRow>[]>(() => [
    {
      key: 'action', label: 'Action', facet: true,
      value: (r) => r.action,
      danger: (r) => r.action === 'BLOCK',
      render: (r) => <Badge tone={ACTION_TONE[r.action] ?? 'neutral'} variant="soft" mono>{r.action}</Badge>,
    },
    { key: 'domain', label: tt('도메인'), mono: true, value: (r) => r.domain },
    {
      key: 'value', label: tt('건수'), type: 'num',
      value: (r) => r.value,
      render: (r) => <span className="tabular">{r.value.toLocaleString()}</span>,
    },
  ], [tt]);

  return (
    <>
      <PageHeader
        title="DNS Query Logs"
        subtitle="Route53 Resolver 쿼리 로그 기반 DNS 분석 — CloudWatch Logs Insights로 RCODE·쿼리 타입·Top 도메인·NXDOMAIN·소스를 집계"
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {statusErr && (
          <div className="text-[13px] text-rose-600">{tt('DNS 로그 상태 조회 실패')}: {statusErr}</div>
        )}
        {!status && !statusErr && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {status && (
          <>
            {/* 상태 밴드: 설정 수 / 연관 VPC / 로그 그룹 / CREATED */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile
                label="쿼리 로그 설정"
                value={configs.length}
                variant={configs.length > 0 ? 'accent' : 'warn'}
                hint={configs.length ? configs.map((c) => c.name || c.id).join(', ') : undefined}
                icon={<ScrollText size={16} />}
              />
              <StatTile label="연관 VPC" value={vpcCount} icon={<Network size={16} />} />
              <StatTile
                label="로그 그룹"
                value={groups.length}
                variant={groups.length > 0 ? 'default' : 'warn'}
                hint="CloudWatch Logs 대상만 분석 가능"
                icon={<Layers size={16} />}
              />
              <StatTile
                label="CREATED 상태"
                value={createdCount}
                variant={configs.length > 0 && createdCount < configs.length ? 'warn' : 'default'}
                hint={configs.length ? `${createdCount}/${configs.length}` : undefined}
                icon={<CheckCircle2 size={16} />}
              />
            </div>

            {/* CW Logs 대상 없음 — amber 온보딩 안내로 degrade, 분석 패널 숨김 */}
            {!onboarded && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-700">
                <div className="font-semibold">{tt('Route53 Resolver query logging 미구성')}</div>
                <p>{tt('Route53 Resolver query logging을 CloudWatch Logs 대상으로 구성하면 DNS 쿼리 로그 분석이 활성화됩니다. S3/Kinesis Data Firehose 대상은 Logs Insights로 조회할 수 없어 분석에 사용할 수 없습니다.')}</p>
                {status.error && <p className="font-mono text-[11.5px]">{status.error}</p>}
              </div>
            )}

            {onboarded && (
              <Card
                title="쿼리 로그 분석"
                subtitle="Logs Insights 집계 쿼리 7종 병렬 실행 — 로그 그룹·기간 변경 시 자동 재조회"
                right={<RangePicker value={range} onChange={setRange} />}
                padded={false}
              >
                {/* 로그 그룹 선택(여러 개일 때만) + 실행 상태 */}
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  {groups.length > 1 ? (
                    <label className="flex items-center gap-1.5 text-[12px] text-ink-500">
                      {tt('로그 그룹')}
                      <select className={SELECT_CLS} value={group} onChange={(e) => setGroup(e.target.value)}>
                        {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </label>
                  ) : (
                    <span className="font-mono text-[11.5px] text-ink-400">{group}</span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {busy && (
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-700">
                        <Loader2 size={13} className="animate-spin" />
                        {tt('Logs Insights 집계 중…')}
                      </span>
                    )}
                    {!busy && a && !queryErr && (
                      <span className="tabular text-[11.5px] text-ink-400">
                        {a.totals.total.toLocaleString()} {tt('쿼리')}
                      </span>
                    )}
                  </div>
                </div>

                {/* 실패는 rose 라인으로 degrade — 이전 결과는 유지 */}
                {queryErr && (
                  <div className="border-t border-ink-100 px-4 py-2 text-[12px] text-rose-600">
                    {tt('집계 실패')}: {queryErr}
                  </div>
                )}

                {/* 부분 실패(failed 배열) — 해당 패널만 빈 상태, amber 라인으로 표기 */}
                {a && a.failed.length > 0 && (
                  <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-700">
                    {tt('일부 집계 실패')}: <span className="font-mono text-[11.5px]">{a.failed.join(', ')}</span>
                  </div>
                )}

                {!a && busy && (
                  <div className="border-t border-ink-100 px-4 py-8 text-center text-[12.5px] text-ink-400">
                    {tt('Logs Insights 집계 중…')}
                  </div>
                )}
              </Card>
            )}

            {onboarded && a && (
              <>
                {/* KPI: 총 쿼리 / NXDOMAIN(비율, >1% warn) / SERVFAIL(>0 danger) / 고유 도메인 */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatTile label="총 쿼리" value={a.totals.total.toLocaleString()} variant="accent" />
                  <StatTile
                    label="NXDOMAIN"
                    value={a.totals.nxdomain.toLocaleString()}
                    variant={nxRate > 1 ? 'warn' : 'default'}
                    hint={nxRateLabel}
                  />
                  <StatTile
                    label="SERVFAIL"
                    value={a.totals.servfail.toLocaleString()}
                    variant={a.totals.servfail > 0 ? 'danger' : 'default'}
                  />
                  <StatTile label="고유 도메인" value={a.totals.uniqueDomains.toLocaleString()} />
                </div>

                {/* 차트: 타임라인 + rcode/qtype 도넛 + Top 도메인 바 */}
                <AreaTrend title="쿼리 타임라인" data={timelineData} xKey="t" yKey="value" />
                <div className="grid gap-6 lg:grid-cols-2">
                  <DonutBreakdown title="RCODE 분포" data={a.rcode} nameKey="name" valueKey="value" colors={RCODE_COLORS} />
                  <DonutBreakdown title="쿼리 타입 분포" data={a.qtype} nameKey="name" valueKey="value" />
                </div>
                <HBarList title="Top 도메인" data={a.topDomains.slice(0, 12)} labelKey="name" valueKey="value" highlightMax />

                {/* 테이블: Top 도메인 / NXDOMAIN Top / Top 소스 (+ DNS Firewall) */}
                <div className="grid gap-6 lg:grid-cols-2 items-start">
                  <Card title="Top 도메인" subtitle="쿼리 수 기준 상위 25개" padded={false}>
                    <MetricTable
                      columns={domainCols}
                      items={a.topDomains}
                      rowKey={(r) => r.name}
                      defaultSortKey="value"
                    />
                  </Card>
                  <Card title="NXDOMAIN Top" subtitle="존재하지 않는 도메인 응답 상위 25개" padded={false}>
                    <MetricTable
                      columns={nxCols}
                      items={a.topNxdomain}
                      rowKey={(r) => r.name}
                      defaultSortKey="value"
                    />
                  </Card>
                </div>
                <div className="grid gap-6 lg:grid-cols-2 items-start">
                  <Card title="Top 소스" subtitle="쿼리를 많이 보낸 소스 IP 상위 25개" padded={false}>
                    <MetricTable
                      columns={sourceCols}
                      items={a.topSources}
                      rowKey={(r, i) => `${r.srcaddr}|${i}`}
                      defaultSortKey="value"
                    />
                  </Card>
                  {a.firewall.length > 0 && (
                    <Card title="DNS Firewall" subtitle="방화벽 규칙에 매칭된 도메인 (BLOCK=차단)" padded={false}>
                      <MetricTable
                        columns={firewallCols}
                        items={a.firewall}
                        rowKey={(r, i) => `${r.action}|${r.domain}|${i}`}
                        defaultSortKey="value"
                      />
                    </Card>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
