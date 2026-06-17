'use client';
import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import DataTable from '@/components/ui/DataTable';
import AreaTrend from '@/components/charts/AreaTrend';
import type { NormalizedResult } from '@/lib/datasource-render';

interface DS { slug: string; kind: string; hasSchema: boolean }

const PH: Record<string, string> = {
  prometheus: 'PromQL… 예: rate(node_cpu_seconds_total[5m])',
  mimir: 'PromQL… 예: up',
  loki: 'LogQL… 예: {job="varlogs"} |= "error"',
  tempo: 'TraceQL… 예: { duration > 500ms }',
  clickhouse: 'SQL… 예: SELECT count() FROM system.tables',
};
const RANGE_KINDS = new Set(['prometheus', 'mimir', 'loki']); // kinds with a *_query_range tool
const selectCls = 'rounded-md border border-ink-200 bg-card px-2.5 py-1.5 text-[13px] text-ink-700';

export default function DatasourcesPage() {
  const [list, setList] = useState<DS[]>([]);
  const [slug, setSlug] = useState('');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState(false);
  const [result, setResult] = useState<NormalizedResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const ds = list.find((d) => d.slug === slug) ?? null;
  const canRange = ds ? RANGE_KINDS.has(ds.kind) : false;

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/datasources');
        if (r.ok) setList((await r.json()).datasources ?? []);
      } catch { /* leave the dropdown empty; the page still renders */ }
    })();
  }, []);

  const run = useCallback(async () => {
    if (!slug || !query.trim()) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await fetch('/api/datasources/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, query, range: canRange && range }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `오류 ${r.status}`);
      setResult(b.result as NormalizedResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '쿼리 실패');
    } finally {
      setBusy(false);
    }
  }, [slug, query, range, canRange]);

  return (
    <div>
      <PageHeader
        title="데이터소스 탐색"
        subtitle="연결된 Prometheus·Mimir·Loki·Tempo·ClickHouse를 네이티브 쿼리 언어로 조회합니다 (읽기 전용)."
      />
      <div className="p-6 lg:p-8 space-y-4">
        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className={selectCls} value={slug} onChange={(e) => { setSlug(e.target.value); setResult(null); setErr(''); }}>
              <option value="">데이터소스 선택…</option>
              {list.map((d) => (
                <option key={d.slug} value={d.slug}>{d.slug} ({d.kind}){d.hasSchema ? ' · 스키마 캐시됨' : ''}</option>
              ))}
            </select>
            {canRange && (
              <label className="inline-flex items-center gap-1.5 text-[13px] text-ink-600 select-none">
                <input type="checkbox" checked={range} onChange={(e) => setRange(e.target.checked)} />
                시간 범위 (range)
              </label>
            )}
          </div>
          <Input
            icon={<Search size={14} />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ds ? PH[ds.kind] ?? '쿼리를 입력하세요' : '먼저 데이터소스를 선택하세요'}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
            disabled={!ds}
          />
          <div className="flex items-center gap-2">
            <Button onClick={run} disabled={busy || !ds || !query.trim()}>{busy ? '실행 중…' : '실행'}</Button>
            {list.length === 0 && (
              <span className="text-[12px] text-ink-400">설정된 데이터소스가 없습니다 — Connectors에서 연결하세요.</span>
            )}
          </div>
          {err && <p className="text-[13px] text-rose-600">{err}</p>}
        </Card>

        {result && <ResultView result={result} />}
      </div>
    </div>
  );
}

function ResultView({ result }: { result: NormalizedResult }) {
  return (
    <div className="space-y-3">
      {result.truncated && (
        <p className="text-[12px] text-amber-700">결과가 잘렸습니다(상한 도달) — 쿼리를 좁혀 다시 시도하세요.</p>
      )}
      {result.shape === 'empty' && (
        <Card className="p-6 text-center text-[13px] text-ink-400">{result.note || '결과 없음'}</Card>
      )}
      {result.shape === 'series' && result.series && (
        <AreaTrend title="시계열" data={result.series} xKey={result.seriesXKey || 't'} yKey={result.seriesYKey || 'value'} />
      )}
      {result.shape === 'series' && result.rows && result.columns && (
        <DataTable columns={result.columns} rows={result.rows} />
      )}
      {(result.shape === 'table' || result.shape === 'logs' || result.shape === 'traces') && result.columns && result.rows && (
        <DataTable columns={result.columns} rows={result.rows} />
      )}
    </div>
  );
}
