'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import { X } from 'lucide-react';
import { useResizablePanel, usePublishDockedWidth, RESIZE_GRIP_CLASS, RESIZE_GRIP_BAR_CLASS } from '@/lib/useResizablePanel';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import Card from '@/components/ui/Card';
import DataTable from '@/components/ui/DataTable';
import SegmentedControl from '@/components/ui/SegmentedControl';
import AreaTrend from '@/components/charts/AreaTrend';
import HBarList from '@/components/charts/HBarList';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { momChangePctDaily, projectMonthEnd, trendPill } from '@/lib/cost';
import { useActiveAccount, accountParam, ALL_ACCOUNTS } from '@/lib/account-context';

interface ServiceCost { service: string; amount: number; [k: string]: unknown }
interface TrendPoint { date: string; amount: number; [k: string]: unknown }
interface MonthlyPoint { month: string; total: number; [k: string]: unknown }
interface Cost { total: number; currency: string; byService: ServiceCost[]; trend?: TrendPoint[]; monthly?: MonthlyPoint[]; forecast?: number | null }
interface UsageType { usageType: string; amount: number; [k: string]: unknown }
interface ServiceDetail { service: string; currency: string; trend: TrendPoint[] | null; byUsageType: UsageType[] | null }

const DASH = '—';
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Trend period presets (months) — v1 parity (src/app/cost/page.tsx PERIODS).
const PERIODS = [
  { label: '이번 달', value: '1' },
  { label: '3개월', value: '3' },
  { label: '6개월', value: '6' },
  { label: '1년', value: '12' },
];

const FANOUT = 6;
async function fetchCost(accountId: string, months: number): Promise<Cost> {
  const p = accountParam(accountId);
  const qs = [p, `months=${months}`].filter(Boolean).join('&');
  const r = await fetch(`/api/cost?${qs}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
/** Merge per-account Cost: sum total, byService (by service), trend (by date), monthly (by month), forecast. */
function mergeCost(parts: Cost[]): Cost {
  const svc = new Map<string, number>(); const tr = new Map<string, number>();
  const mo = new Map<string, number>(); let total = 0; let forecast = 0; let hasForecast = false;
  for (const p of parts) {
    total += p.total ?? 0;
    if (typeof p.forecast === 'number') { forecast += p.forecast; hasForecast = true; }
    for (const s of p.byService ?? []) svc.set(s.service, (svc.get(s.service) ?? 0) + s.amount);
    for (const t of p.trend ?? []) tr.set(t.date, (tr.get(t.date) ?? 0) + t.amount);
    for (const m of p.monthly ?? []) mo.set(m.month, (mo.get(m.month) ?? 0) + m.total);
  }
  return {
    total, currency: parts[0]?.currency ?? 'USD',
    byService: [...svc.entries()].map(([service, amount]) => ({ service, amount })).sort((a, b) => b.amount - a.amount),
    trend: [...tr.entries()].map(([date, amount]) => ({ date, amount })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    monthly: [...mo.entries()].map(([month, total]) => ({ month, total })).sort((a, b) => (a.month < b.month ? -1 : 1)),
    forecast: hasForecast ? forecast : null,
  };
}
async function loadAllAccountsCost(months: number): Promise<Cost> {
  const ar = await fetch('/api/accounts');
  const accts: Array<{ accountId: string; isHost: boolean; enabled: boolean }> =
    ar.ok ? ((await ar.json().catch(() => ({ accounts: [] }))).accounts ?? []) : [];
  const ids = accts.filter((a) => a.enabled).map((a) => (a.isHost ? 'self' : a.accountId));
  if (!ids.length) return await fetchCost('self', months);
  const parts: Cost[] = [];
  for (let i = 0; i < ids.length; i += FANOUT) {
    const chunk = await Promise.all(ids.slice(i, i + FANOUT).map((id) =>
      fetchCost(id, months).catch(() => ({ total: 0, currency: 'USD', byService: [] } as Cost))));
    parts.push(...chunk);
  }
  return mergeCost(parts);
}

export default function CostPage() {
  const [d, setD] = useState<Cost | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [active] = useActiveAccount();
  const [period, setPeriod] = useState('6');

  // Service drill-down panel: name selected (open) + lazily-fetched detail + its loading state.
  const [picked, setPicked] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  // Monotonic sequence — a slower detail response for service A must not land
  // under service B's panel title (P4 gate: codex; same class as the EKS guards).
  const detailSeqRef = useRef(0);
  // 차트가 들어가는 패널 — 기본 폭을 넉넉히(640), 좌측 엣지 드래그로 조절·영속.
  const { width: detailWidth, startResize: startDetailResize } = useResizablePanel('awsops_cost_detail_width', 640);
  // Coordinate the drill-down panel with the global chat so they don't overlap.
  usePublishDockedWidth(!!picked, detailWidth);

  const openDetail = useCallback(async (service: string) => {
    const seq = ++detailSeqRef.current;
    setPicked(service);
    setDetail(null);
    setDetailBusy(true);
    try {
      const r = await fetch(`/api/cost/detail?service=${encodeURIComponent(service)}`);
      if (seq !== detailSeqRef.current) return; // superseded by a newer click
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      if (seq === detailSeqRef.current) setDetail(body);
    } catch {
      if (seq === detailSeqRef.current) setDetail(null);
    } finally {
      if (seq === detailSeqRef.current) setDetailBusy(false);
    }
  }, []);

  const closeDetail = useCallback(() => { setPicked(null); setDetail(null); }, []);

  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [picked, closeDetail]);

  // Monotonic sequence — a slower response for a since-abandoned period/account must not
  // overwrite the currently-selected one (same class as loadSeqRef in bedrock/page.tsx).
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setBusy(true);
    const months = Number(period);
    try {
      const data = active === ALL_ACCOUNTS ? await loadAllAccountsCost(months) : await fetchCost(active, months);
      if (seq !== loadSeqRef.current) return; // superseded by a newer period/account switch
      setD(data);
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      if (seq === loadSeqRef.current) setErr(String(e));
    } finally {
      if (seq === loadSeqRef.current) setBusy(false);
    }
  }, [active, period]);

  useEffect(() => { load(); }, [load]);

  // byService arrives sorted descending from getMtdCost.
  const byService = d?.byService ?? [];
  const top = byService[0];
  const trend = d?.trend ?? [];

  // Donut: top 6 services + "기타" rollup of the remainder.
  const donutData = (() => {
    if (byService.length <= 6) return byService.map((s) => ({ service: s.service, amount: s.amount }));
    const head = byService.slice(0, 6).map((s) => ({ service: s.service, amount: s.amount }));
    const rest = byService.slice(6).reduce((acc, s) => acc + s.amount, 0);
    return rest > 0 ? [...head, { service: '기타', amount: rest }] : head;
  })();

  const total = d?.total ?? 0;
  const tableRows = byService.map((s) => ({
    service: s.service,
    amount: usd(s.amount),
    share: total > 0 ? `${((s.amount / total) * 100).toFixed(1)}%` : DASH,
  }));

  // MoM (from the monthly series) + month-end forecast (AWS CE forecast if present, else linear projection).
  const monthly = d?.monthly ?? [];
  const thisMonth = monthly.length > 0 ? monthly[monthly.length - 1].total : total;
  const lastMonth = monthly.length > 1 ? monthly[monthly.length - 2].total : 0;
  // MoM on a PER-DAY run-rate basis: the current month is month-to-date (partial), so comparing it
  // against the FULL previous month read as a bogus large drop (e.g. -51% on the 17th). Compare
  // average daily spend instead (이번 달 일평균 vs 전월 일평균).
  const mom = momChangePctDaily(thisMonth, lastMonth, new Date());
  const monthEndEstimate = d?.forecast != null ? total + d.forecast : projectMonthEnd(total, new Date());

  return (
    <>
      <PageHeader
        title="Cost Explorer"
        subtitle="Cost Explorer 기반 이번 달 누적 비용 · 서비스별 분포"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="text-[13px] text-rose-600">
            로드 실패: {err} (Cost Explorer 권한/요금 또는 세션 만료 확인)
          </div>
        )}
        {!d && !err && <div className="text-ink-400">로딩 중…</div>}

        {d && (
          <>
            {/* ---- KPI tiles ---- */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatTile
                label={`이번 달 누적 (${d.currency})`}
                value={usd(total)}
                variant="accent"
              />
              <StatTile
                label="전월 대비 (MoM · 일평균)"
                value={lastMonth > 0 ? `${mom >= 0 ? '+' : ''}${mom.toFixed(1)}%` : DASH}
                trend={lastMonth > 0 ? trendPill(mom) : undefined}
                hint={lastMonth > 0 ? `일평균 기준 · 전월 ${usd(lastMonth)}` : '기준월 부족'}
              />
              <StatTile
                label="예상 월말 비용"
                value={usd(monthEndEstimate)}
                hint={d?.forecast != null ? 'AWS 예측' : '선형 추정'}
                variant="warn"
              />
              <StatTile label="서비스 수" value={byService.length} />
              <StatTile
                label="최대 서비스"
                value={top ? usd(top.amount) : DASH}
                hint={top ? top.service : undefined}
                variant="warn"
              />
            </div>

            {/* ---- Monthly trend area (MoM context) + period filter ---- */}
            {monthly.length > 1 ? (
              <AreaTrend
                title="월별 비용 추이"
                right={<SegmentedControl options={PERIODS} value={period} onChange={setPeriod} />}
                data={monthly}
                xKey="month"
                yKey="total"
                valuePrefix="$"
              />
            ) : (
              <Card title="월별 비용 추이" right={<SegmentedControl options={PERIODS} value={period} onChange={setPeriod} />}>
                <div className="text-[13px] text-ink-400">
                  {monthly.length === 1 ? '추이 표시에는 2개월 이상 필요 — 더 긴 기간을 선택하세요' : '비용 추이 데이터 없음'}
                </div>
              </Card>
            )}

            {/* ---- Daily trend area (full-width) ---- */}
            {trend.length > 0 ? (
              <AreaTrend title="일별 비용 추이" data={trend} xKey="date" yKey="amount" valuePrefix="$" />
            ) : (
              <Card title="일별 비용 추이">
                <div className="text-[13px] text-ink-400">비용 추이 데이터 없음</div>
              </Card>
            )}

            {/* ---- Row: service HBar (wide) + composition donut ---- */}
            {byService.length > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6">
                <HBarList
                  title="서비스별 비용"
                  data={byService}
                  labelKey="service"
                  valueKey="amount"
                  valuePrefix="$"
                />
                <DonutBreakdown
                  title="비용 구성"
                  data={donutData}
                  nameKey="service"
                  valueKey="amount"
                  valuePrefix="$"
                />
              </div>
            ) : null}

            {/* ---- Detail table: service / amount / share ---- */}
            <section className="flex flex-col gap-3">
              <h2 className="text-[13px] font-semibold text-ink-800">서비스 상세</h2>
              <DataTable
                columns={[
                  { key: 'service', label: '서비스' },
                  { key: 'amount', label: `비용 (${d.currency})` },
                  { key: 'share', label: '점유율' },
                ]}
                rows={tableRows}
                onRowClick={(row) => openDetail(String(row.service))}
              />
              <p className="text-[12px] text-ink-400">행을 클릭하면 서비스별 일별 추이·사용 유형 분해를 볼 수 있습니다.</p>
            </section>
          </>
        )}
      </div>

      {/* ---- Service drill-down panel (lazy: daily trend + usage-type rollup) ---- */}
      {picked && (
        <>
          <div aria-hidden onClick={closeDetail} className="fixed inset-0 z-40 bg-ink-900/20" />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={`${picked} 비용 상세`}
            className="fixed right-0 top-0 z-50 flex h-full max-w-full flex-col border-l border-ink-100 bg-card shadow-pop"
            style={{ width: detailWidth }}
          >
            <div onMouseDown={startDetailResize} title="드래그하여 폭 조절" aria-label="패널 폭 조절" role="separator" className={RESIZE_GRIP_CLASS}>
              <div className={RESIZE_GRIP_BAR_CLASS} />
            </div>
            <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
              <h2 className="min-w-0 break-words text-[13px] font-semibold text-ink-800">{picked}</h2>
              <button
                type="button"
                onClick={closeDetail}
                aria-label="닫기"
                className="-mr-1 shrink-0 rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
              >
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
              {detailBusy && <div className="text-[13px] text-ink-400">로딩 중…</div>}
              {!detailBusy && (
                <>
                  {detail?.trend == null ? (
                    <Card title="일별 비용 추이 (30일)">
                      <div className="text-[13px] text-ink-400">추이 호출 실패 — 잠시 후 재시도</div>
                    </Card>
                  ) : detail.trend.length > 0 ? (
                    <AreaTrend title="일별 비용 추이 (30일)" data={detail.trend} xKey="date" yKey="amount" valuePrefix="$" />
                  ) : (
                    <Card title="일별 비용 추이 (30일)">
                      <div className="text-[13px] text-ink-400">데이터 없음</div>
                    </Card>
                  )}

                  {detail?.byUsageType == null ? (
                    <Card title="사용 유형별 비용 (최근 3개월)">
                      <div className="text-[13px] text-ink-400">사용 유형 호출 실패 — 잠시 후 재시도</div>
                    </Card>
                  ) : detail.byUsageType.length > 0 ? (
                    <HBarList
                      title="사용 유형별 비용 (최근 3개월)"
                      data={detail.byUsageType}
                      labelKey="usageType"
                      valueKey="amount"
                      valuePrefix="$"
                    />
                  ) : (
                    <Card title="사용 유형별 비용 (최근 3개월)">
                      <div className="text-[13px] text-ink-400">데이터 없음</div>
                    </Card>
                  )}
                </>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
