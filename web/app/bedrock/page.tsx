'use client';
import { useEffect, useState } from 'react';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';
import DataTable from '@/components/ui/DataTable';
import SegmentedControl from '@/components/ui/SegmentedControl';
import AreaTrend from '@/components/charts/AreaTrend';
import BarDistribution from '@/components/charts/BarDistribution';
import DonutBreakdown from '@/components/charts/DonutBreakdown';

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

export default function BedrockPage() {
  const [range, setRange] = useState('24h');
  const [d, setD] = useState<BedrockData | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setD(null);
    setErr('');
    fetch(`/api/bedrock-metrics?range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setD)
      .catch((e) => setErr(String(e)));
  }, [range]);

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
        right={<Badge tone="brand" variant="soft" dot>CloudWatch · AWS/Bedrock</Badge>}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
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
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
                <StatTile label={`총 비용 (${range})`} value={usd(totalCost)} variant="accent" />
                <StatTile label="호출 수" value={totalInvocations.toLocaleString()} />
                <StatTile label="입력 토큰" value={compact(totalInput)} />
                <StatTile label="출력 토큰" value={compact(totalOutput)} />
                <StatTile label="캐시 절감" value={usd(totalSavings)} hint="cache read 할인" variant="warn" />
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
      </div>
    </>
  );
}
