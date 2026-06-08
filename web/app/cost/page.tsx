'use client';
import { useEffect, useState } from 'react';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';
import DataTable from '@/components/ui/DataTable';
import AreaTrend from '@/components/charts/AreaTrend';
import HBarList from '@/components/charts/HBarList';
import DonutBreakdown from '@/components/charts/DonutBreakdown';

interface ServiceCost { service: string; amount: number; [k: string]: unknown }
interface TrendPoint { date: string; amount: number; [k: string]: unknown }
interface Cost { total: number; currency: string; byService: ServiceCost[]; trend?: TrendPoint[] }

const DASH = '—';
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CostPage() {
  const [d, setD] = useState<Cost | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/cost')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setD)
      .catch((e) => setErr(String(e)));
  }, []);

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

  return (
    <>
      <PageHeader
        title="Cost Explorer"
        subtitle="Cost Explorer 기반 이번 달 누적 비용 · 서비스별 분포"
        right={<Badge tone="brand" variant="soft" dot>Cost Explorer API</Badge>}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="text-[13px] text-rose-600">
            로드 실패: {err} (Cost Explorer 권한/요금 또는 세션 만료 확인)
          </div>
        )}
        {!d && !err && <div className="text-ink-400">로딩 중…</div>}

        {d && (
          <>
            {/* ---- KPI tiles ---- */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatTile
                label={`이번 달 누적 (${d.currency})`}
                value={usd(total)}
                variant="accent"
              />
              <StatTile label="서비스 수" value={byService.length} />
              <StatTile
                label="최대 서비스"
                value={top ? usd(top.amount) : DASH}
                hint={top ? top.service : undefined}
                variant="warn"
              />
            </div>

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
              />
            </section>
          </>
        )}
      </div>
    </>
  );
}
