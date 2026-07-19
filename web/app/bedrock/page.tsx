'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import { DollarSign, Activity, ArrowDownToLine, ArrowUpFromLine, PiggyBank } from 'lucide-react';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import DataTable from '@/components/ui/DataTable';
import SegmentedControl from '@/components/ui/SegmentedControl';
import AreaTrend from '@/components/charts/AreaTrend';
import BarDistribution from '@/components/charts/BarDistribution';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { useActiveAccount, accountParam, ALL_ACCOUNTS } from '@/lib/account-context';
import ChatOpsStatsCard from '@/components/chat/ChatOpsStatsCard';

interface CostBreakdown { inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; total: number; cacheSavings: number }
interface ModelMetric {
  modelId: string; label: string; invocations: number; inputTokens: number; outputTokens: number;
  avgLatencyMs: number; clientErrors: number; serverErrors: number; cacheReadTokens: number; cacheWriteTokens: number; cost: CostBreakdown;
}
interface BedrockData { range: string; models: ModelMetric[]; totalCost: number; series: { t: string; tokens: number }[] }

const RANGES = ['1h', '6h', '24h', '7d', '30d'];
const DASH = '—';
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compact = (n: number) => n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const FANOUT = 6; // bounded parallel per-account fetches for "All accounts"
const EMPTY = (range: string): BedrockData => ({ range, models: [], totalCost: 0, series: [] });

async function fetchBedrock(range: string, accountId: string): Promise<BedrockData> {
  const p = accountParam(accountId);
  const r = await fetch(`/api/bedrock-metrics?range=${range}${p ? `&${p}` : ''}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** Merge per-account BedrockData: sum per modelId (tokens/invocations/cost), invocation-weighted latency. */
function mergeBedrock(parts: BedrockData[]): BedrockData {
  const byModel = new Map<string, ModelMetric>();
  const lat = new Map<string, { lat: number; inv: number }>();
  let totalCost = 0;
  const seriesByT = new Map<string, number>();
  for (const p of parts) {
    totalCost += p.totalCost ?? 0;
    for (const m of p.models ?? []) {
      const la = lat.get(m.modelId) ?? { lat: 0, inv: 0 };
      la.lat += (m.avgLatencyMs || 0) * (m.invocations || 0); la.inv += m.invocations || 0;
      lat.set(m.modelId, la);
      const e = byModel.get(m.modelId);
      if (!e) { byModel.set(m.modelId, { ...m, cost: { ...m.cost } }); continue; }
      e.invocations += m.invocations; e.inputTokens += m.inputTokens; e.outputTokens += m.outputTokens;
      e.cacheReadTokens += m.cacheReadTokens; e.cacheWriteTokens += m.cacheWriteTokens;
      e.clientErrors += m.clientErrors; e.serverErrors += m.serverErrors;
      e.cost = {
        inputCost: e.cost.inputCost + m.cost.inputCost, outputCost: e.cost.outputCost + m.cost.outputCost,
        cacheReadCost: e.cost.cacheReadCost + m.cost.cacheReadCost, cacheWriteCost: e.cost.cacheWriteCost + m.cost.cacheWriteCost,
        total: e.cost.total + m.cost.total, cacheSavings: e.cost.cacheSavings + m.cost.cacheSavings,
      };
    }
    for (const s of p.series ?? []) seriesByT.set(s.t, (seriesByT.get(s.t) ?? 0) + s.tokens);
  }
  for (const [id, e] of byModel) { const la = lat.get(id)!; e.avgLatencyMs = la.inv ? la.lat / la.inv : 0; }
  const series = [...seriesByT.entries()].map(([t, tokens]) => ({ t, tokens })).sort((a, b) => (a.t < b.t ? -1 : 1));
  return { range: parts[0]?.range ?? '', models: [...byModel.values()], totalCost, series };
}

/** Client-side fan-out: fetch every enabled account in bounded parallel + aggregate (thin-BFF). */
async function loadAllAccounts(range: string): Promise<BedrockData> {
  const ar = await fetch('/api/accounts');
  const accts: Array<{ accountId: string; isHost: boolean; enabled: boolean }> =
    ar.ok ? ((await ar.json().catch(() => ({ accounts: [] }))).accounts ?? []) : [];
  const ids = accts.filter((a) => a.enabled).map((a) => (a.isHost ? 'self' : a.accountId));
  if (!ids.length) return await fetchBedrock(range, 'self');
  const parts: BedrockData[] = [];
  for (let i = 0; i < ids.length; i += FANOUT) {
    const chunk = await Promise.all(ids.slice(i, i + FANOUT).map((id) => fetchBedrock(range, id).catch(() => EMPTY(range))));
    parts.push(...chunk);
  }
  return mergeBedrock(parts);
}

export default function BedrockPage() {
  const [range, setRange] = useState('24h');
  const [d, setD] = useState<BedrockData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [active] = useActiveAccount(); // 'self' (host) | <accountId> | '__all__'

  // Closes over the current `range`; the range-switch useEffect re-fires this on
  // change, and the RefreshButton re-runs it for the same range on demand.
  // Monotonic sequence — an older range's slow response must not overwrite the
  // currently-selected range (P4 gate: codex).
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setD(null);
    setErr('');
    setBusy(true);
    try {
      const body = active === ALL_ACCOUNTS ? await loadAllAccounts(range) : await fetchBedrock(range, active);
      if (seq !== loadSeqRef.current) return; // superseded (range/account switched or re-refreshed)
      setD(body);
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      if (seq === loadSeqRef.current) setErr(String(e));
    } finally {
      if (seq === loadSeqRef.current) setBusy(false);
    }
  }, [range, active]);

  useEffect(() => { load(); }, [load]);

  const models = d?.models ?? [];
  const totalCost = d?.totalCost ?? 0;
  const totalInvocations = models.reduce((s, m) => s + m.invocations, 0);
  const totalInput = models.reduce((s, m) => s + m.inputTokens, 0);
  const totalOutput = models.reduce((s, m) => s + m.outputTokens, 0);
  const totalSavings = models.reduce((s, m) => s + m.cost.cacheSavings, 0);

  const costRows = models.map((m) => ({ label: m.label, cost: m.cost.total }));
  const invRows = models.map((m) => ({ label: m.label, invocations: m.invocations }));
  const tableRows = models.map((m) => ({
    model: m.label,
    invocations: m.invocations.toLocaleString(),
    inputTokens: compact(m.inputTokens),
    outputTokens: compact(m.outputTokens),
    avgLatencyMs: m.avgLatencyMs ? `${m.avgLatencyMs} ms` : DASH,
    errors: m.clientErrors + m.serverErrors,
    cost: usd(m.cost.total),
  }));

  return (
    <>
      <PageHeader
        title="Bedrock Usage"
        subtitle="AWS/Bedrock CloudWatch 메트릭 · 모델별 토큰·비용·캐시"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        <div className="overflow-x-auto">
          <SegmentedControl options={RANGES} value={range} onChange={setRange} />
        </div>

        {err && <div className="text-[13px] text-rose-600">로드 실패: {err} (CloudWatch 권한 또는 세션 만료 확인)</div>}
        {!d && !err && <div className="text-ink-400">로딩 중…</div>}

        {d && !err && (
          models.length === 0 ? (
            <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
              이 기간에 Bedrock 모델 호출 메트릭이 없습니다.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <StatTile label={`총 비용 (${range})`} value={usd(totalCost)} variant="accent" icon={<DollarSign size={16} />} />
                <StatTile label="호출 수" value={totalInvocations.toLocaleString()} icon={<Activity size={16} />} />
                <StatTile label="입력 토큰" value={compact(totalInput)} icon={<ArrowDownToLine size={16} />} />
                <StatTile label="출력 토큰" value={compact(totalOutput)} icon={<ArrowUpFromLine size={16} />} />
                <StatTile label="캐시 절감" value={usd(totalSavings)} hint="cache read 할인" variant="warn" icon={<PiggyBank size={16} />} />
              </div>

              {d.series.length > 1 && (
                <AreaTrend title="토큰 추이 (입력+출력)" data={d.series} xKey="t" yKey="tokens" />
              )}

              <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6">
                <BarDistribution title="모델별 호출 수" data={invRows} xKey="label" yKey="invocations" />
                <DonutBreakdown title="모델별 비용" data={costRows} nameKey="label" valueKey="cost" valuePrefix="$" />
              </div>

              <section className="flex flex-col gap-3">
                <h2 className="text-[13px] font-semibold text-ink-800">모델 상세</h2>
                <DataTable
                  columns={[
                    { key: 'model', label: '모델' },
                    { key: 'invocations', label: '호출' },
                    { key: 'inputTokens', label: '입력 토큰' },
                    { key: 'outputTokens', label: '출력 토큰' },
                    { key: 'avgLatencyMs', label: '평균 지연' },
                    { key: 'errors', label: '에러' },
                    { key: 'cost', label: '비용' },
                  ]}
                  rows={tableRows}
                />
              </section>
            </>
          )
        )}

        {/* v1-parity AI-call ops stats — independent of the CloudWatch range/account above
            (own /api/chat/stats fetch); self-hides when nothing is recorded. */}
        <ChatOpsStatsCard />
      </div>
    </>
  );
}
