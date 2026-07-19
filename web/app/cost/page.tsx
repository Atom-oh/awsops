'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Filter, Calendar, DollarSign, TrendingUp, CalendarDays, Layers, BarChart3 } from 'lucide-react';
import { useResizablePanel, usePublishDockedWidth, RESIZE_GRIP_CLASS, RESIZE_GRIP_BAR_CLASS } from '@/lib/useResizablePanel';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import Card from '@/components/ui/Card';
import DataTable from '@/components/ui/DataTable';
import AreaTrend from '@/components/charts/AreaTrend';
import HBarList from '@/components/charts/HBarList';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import {
  momChangePctDaily, projectMonthEnd, trendPill,
  PERIOD_MONTHS, PERIOD_OPTIONS, allServiceNames, filterMonthlyTotals, filterDailyTotals,
  serviceChangeRows, mergeMonthlyByService, mergeDailyByService,
  type MonthlyServiceCostPoint, type DailyServiceCostPoint,
} from '@/lib/cost';
import { useActiveAccount, accountParam, ALL_ACCOUNTS } from '@/lib/account-context';

interface TrendPoint { date: string; amount: number; [k: string]: unknown }
// Client model: only `forecast` is read directly off the API response — the monthly/daily TOTALS
// the page renders are always DERIVED from monthlyByService/dailyByService via lib/cost.ts's
// filter*Totals (so period + service filtering apply uniformly, incl. the "전체 계정" merge below).
// The API also returns flat `byService`/`trend`/`monthly` fields (older-client back-compat) —
// intentionally unused here.
interface Cost {
  currency: string; forecast?: number | null;
  monthlyByService: MonthlyServiceCostPoint[]; dailyByService: DailyServiceCostPoint[];
}
interface UsageType { usageType: string; amount: number; [k: string]: unknown }
interface ServiceDetail { service: string; currency: string; trend: TrendPoint[] | null; byUsageType: UsageType[] | null }

const DASH = '—';
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DEFAULT_PERIOD = '3m'; // v1 default

const FANOUT = 6;
async function fetchCost(accountId: string, months: number): Promise<Cost> {
  const p = accountParam(accountId);
  const qs = new URLSearchParams({ months: String(months) });
  const r = await fetch(`/api/cost?${p ? `${p}&` : ''}${qs}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
/** Merge per-account Cost: sum forecast + the raw month×service / date×service matrices (every
 *  rendered total is derived from these via lib/cost.ts, so period + service filtering apply
 *  uniformly whether one account or "전체 계정" is selected). */
function mergeCost(parts: Cost[]): Cost {
  const monthlyByService = mergeMonthlyByService(parts.map((p) => p.monthlyByService ?? []));
  const dailyByService = mergeDailyByService(parts.map((p) => p.dailyByService ?? []));
  return {
    currency: parts[0]?.currency ?? 'USD',
    forecast: parts.some((p) => typeof p.forecast === 'number')
      ? parts.reduce((s, p) => s + (p.forecast ?? 0), 0) : null,
    monthlyByService, dailyByService,
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
      fetchCost(id, months).catch(() => ({ currency: 'USD', forecast: null, monthlyByService: [], dailyByService: [] } as Cost))));
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

  // v1-parity filter menu: period (트레일링 개월 수) + multi-select service filter. Empty selection
  // = no filter = all services (matches v1's Set-based semantics exactly).
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [showServiceFilter, setShowServiceFilter] = useState(false);

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
      // Scope the drill-down to the selected account (v1 parity). '전체 계정' keeps host scope —
      // per-account fan-out+merge for the detail panel is not worth the 3× CE calls per click.
      const acct = active !== ALL_ACCOUNTS ? accountParam(active) : '';
      const r = await fetch(`/api/cost/detail?service=${encodeURIComponent(service)}${acct ? `&${acct}` : ''}`);
      if (seq !== detailSeqRef.current) return; // superseded by a newer click
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      if (seq === detailSeqRef.current) setDetail(body);
    } catch {
      if (seq === detailSeqRef.current) setDetail(null);
    } finally {
      if (seq === detailSeqRef.current) setDetailBusy(false);
    }
  }, [active]);

  const closeDetail = useCallback(() => { setPicked(null); setDetail(null); }, []);

  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [picked, closeDetail]);

  const load = useCallback(async () => {
    setBusy(true);
    const months = PERIOD_MONTHS[period] ?? 6;
    try {
      const data = active === ALL_ACCOUNTS ? await loadAllAccountsCost(months) : await fetchCost(active, months);
      setD(data);
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [active, period]);

  useEffect(() => { load(); }, [load]);

  // A period/account switch can leave a selected service that no longer exists in the new window —
  // silently drop it rather than filtering everything down to zero with a stale, invisible selection.
  const allServices = useMemo(() => allServiceNames(d?.monthlyByService ?? []), [d]);
  useEffect(() => {
    setSelectedServices((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((s) => allServices.includes(s)));
      return next.size === prev.size ? prev : next;
    });
  }, [allServices]);

  const toggleService = (svc: string) => {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      if (next.has(svc)) next.delete(svc); else next.add(svc);
      return next;
    });
  };

  // ---- Filtered views (period scoped server-side via `months`; service filter applied here) ----
  const monthlyByService = d?.monthlyByService ?? [];
  const dailyByService = d?.dailyByService ?? [];
  const monthly = useMemo(() => filterMonthlyTotals(monthlyByService, selectedServices), [monthlyByService, selectedServices]);
  const trend = useMemo(() => filterDailyTotals(dailyByService, selectedServices), [dailyByService, selectedServices]);
  const changeRows = useMemo(() => serviceChangeRows(monthlyByService, selectedServices), [monthlyByService, selectedServices]);

  const total = changeRows.reduce((s, r) => s + r.current, 0);
  const top = changeRows[0];
  const currency = d?.currency ?? 'USD';

  // Donut: top 6 filtered services + "기타" rollup of the remainder.
  const donutData = (() => {
    if (changeRows.length <= 6) return changeRows.map((s) => ({ service: s.service, amount: s.current }));
    const head = changeRows.slice(0, 6).map((s) => ({ service: s.service, amount: s.current }));
    const rest = changeRows.slice(6).reduce((acc, s) => acc + s.current, 0);
    return rest > 0 ? [...head, { service: '기타', amount: rest }] : head;
  })();
  const hbarData = changeRows.map((s) => ({ service: s.service, amount: s.current }));

  const tableRows = changeRows.map((s) => ({
    service: s.service,
    current: usd(s.current),
    previous: usd(s.previous),
    change: `${s.change > 0 ? '+' : ''}${s.change.toFixed(1)}%`,
    share: `${s.share.toFixed(1)}%`,
  }));

  // MoM (from the FILTERED monthly series) + month-end forecast. AWS's CE forecast is inherently
  // account/service-unscoped (whole-account), so it only applies when NO service filter is active —
  // with a filter on, fall back to the linear projection of the filtered total (honest > precise-looking).
  const thisMonth = monthly.length > 0 ? monthly[monthly.length - 1].total : total;
  const lastMonth = monthly.length > 1 ? monthly[monthly.length - 2].total : 0;
  const mom = momChangePctDaily(thisMonth, lastMonth, new Date());
  const useAwsForecast = selectedServices.size === 0 && d?.forecast != null;
  const monthEndEstimate = useAwsForecast ? total + (d!.forecast as number) : projectMonthEnd(total, new Date());

  return (
    <>
      <PageHeader
        title="Cost Explorer"
        subtitle="Cost Explorer 기반 누적 비용 · 기간/서비스 필터 · 서비스별 분포"
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
            {/* ---- Period + Service filter (v1 parity) ---- */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                <Calendar size={14} className="text-ink-400" />
                {PERIOD_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setPeriod(p.value)}
                    className={
                      'rounded-md px-3 py-1.5 text-[12px] font-mono transition-colors ' +
                      (period === p.value
                        ? 'border border-brand-200 bg-brand-50 text-brand-700'
                        : 'border border-ink-100 bg-card text-ink-500 hover:text-ink-800')
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowServiceFilter((v) => !v)}
                className={
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors ' +
                  (showServiceFilter || selectedServices.size > 0
                    ? 'border border-brand-200 bg-brand-50 text-brand-700'
                    : 'border border-ink-100 bg-card text-ink-500 hover:text-ink-800')
                }
              >
                <Filter size={12} />
                서비스 필터
                {selectedServices.size > 0 && (
                  <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">{selectedServices.size}</span>
                )}
              </button>
              {selectedServices.size > 0 && (
                <button onClick={() => setSelectedServices(new Set())} className="text-[12px] text-ink-400 hover:text-ink-800">
                  초기화
                </button>
              )}
            </div>

            {showServiceFilter && (
              <div className="rounded-lg border border-ink-100 bg-card p-4">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">서비스로 필터링 ({allServices.length})</p>
                {allServices.length === 0 ? (
                  <div className="text-[12px] text-ink-400">선택된 기간에 서비스 데이터가 없습니다.</div>
                ) : (
                  <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
                    {allServices.map((svc) => (
                      <button
                        key={svc}
                        onClick={() => toggleService(svc)}
                        className={
                          'rounded px-2.5 py-1 text-[11px] font-mono transition-colors ' +
                          (selectedServices.has(svc)
                            ? 'border border-brand-200 bg-brand-50 text-brand-700'
                            : 'border border-ink-100 bg-paper-muted text-ink-500 hover:text-ink-800')
                        }
                      >
                        {svc}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- KPI tiles ---- */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatTile
                label={`이번 달 누적 (${currency})`}
                value={usd(total)}
                variant="accent"
                icon={<DollarSign size={16} />}
              />
              <StatTile
                label="전월 대비 (MoM · 일평균)"
                value={lastMonth > 0 ? `${mom >= 0 ? '+' : ''}${mom.toFixed(1)}%` : DASH}
                trend={lastMonth > 0 ? trendPill(mom) : undefined}
                icon={<TrendingUp size={16} />}
                hint={lastMonth > 0 ? `일평균 기준 · 전월 ${usd(lastMonth)}` : '기준월 부족'}
              />
              <StatTile
                label="예상 월말 비용"
                value={usd(monthEndEstimate)}
                hint={useAwsForecast ? 'AWS 예측' : selectedServices.size > 0 ? '선형 추정 · 서비스 필터 적용 중' : '선형 추정'}
                variant="warn"
                icon={<CalendarDays size={16} />}
              />
              <StatTile label="서비스 수" value={changeRows.length} icon={<Layers size={16} />} />
              <StatTile
                label="최대 서비스"
                value={top ? usd(top.current) : DASH}
                hint={top ? top.service : undefined}
                variant="warn"
                icon={<BarChart3 size={16} />}
              />
            </div>

            {/* ---- Monthly trend area (MoM context) ---- */}
            {monthly.length > 1 && (
              <AreaTrend title="월별 비용 추이" data={monthly} xKey="month" yKey="total" valuePrefix="$" />
            )}

            {/* ---- Daily trend area (full-width, trailing 30 days) ---- */}
            {trend.length > 0 ? (
              <AreaTrend title="일별 비용 추이 (최근 30일)" data={trend} xKey="date" yKey="amount" valuePrefix="$" />
            ) : (
              <Card title="일별 비용 추이 (최근 30일)">
                <div className="text-[13px] text-ink-400">비용 추이 데이터 없음</div>
              </Card>
            )}

            {/* ---- Row: service HBar (wide) + composition donut ---- */}
            {changeRows.length > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6">
                <HBarList
                  title="서비스별 비용"
                  data={hbarData}
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

            {/* ---- Detail table: service / 이번 달 / 전월 / 변화율 / 점유율 ---- */}
            <section className="flex flex-col gap-3">
              <h2 className="text-[13px] font-semibold text-ink-800">서비스 상세</h2>
              <DataTable
                columns={[
                  { key: 'service', label: '서비스' },
                  { key: 'current', label: `이번 달 (${currency})` },
                  { key: 'previous', label: '전월' },
                  { key: 'change', label: '변화율' },
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
