'use client';
import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import DataTable from '@/components/ui/DataTable';
import AreaTrend from '@/components/charts/AreaTrend';
import type { NormalizedResult } from '@/lib/datasource-render';

// A datasource INSTANCE (the hub model): identified by bigint id, with a user-given name.
export interface DatasourceInstance {
  id: number;
  name: string;
  kind: string;
  authType?: string | null;
  isDefault?: boolean;
  connected?: boolean;
}

const PH: Record<string, string> = {
  prometheus: 'PromQL… 예: rate(node_cpu_seconds_total[5m])',
  mimir: 'PromQL… 예: up',
  loki: 'LogQL… 예: {job="varlogs"} |= "error"',
  tempo: 'TraceQL… 예: { duration > 500ms }',
  clickhouse: 'SQL… 예: SELECT count() FROM system.tables',
};
const RANGE_KINDS = new Set(['prometheus', 'mimir', 'loki']); // kinds with a *_query_range tool
const selectCls = 'rounded-md border border-ink-200 bg-card px-2.5 py-1.5 text-[13px] text-ink-700';

/** Query console for a datasource instance (PromQL/LogQL/TraceQL/SQL) + an AI NL→query assist.
 *  Read-only. When `instanceId` is given (the per-instance route) the picker is hidden. */
export default function ExplorePanel({ instanceId }: { instanceId?: number }) {
  const [list, setList] = useState<DatasourceInstance[]>([]);
  const [selId, setSelId] = useState<number | ''>(instanceId ?? '');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState(false);
  const [result, setResult] = useState<NormalizedResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [nl, setNl] = useState('');
  const [genBusy, setGenBusy] = useState(false);

  const ds = list.find((d) => d.id === selId) ?? null;
  const canRange = ds ? RANGE_KINDS.has(ds.kind) : false;

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/datasources');
        if (r.ok) {
          const items: DatasourceInstance[] = (await r.json()).datasources ?? [];
          setList(items);
          // preselect: the pinned instance, else the only one
          if (instanceId && items.some((d) => d.id === instanceId)) setSelId(instanceId);
          else if (!instanceId && items.length === 1) setSelId(items[0].id);
        }
      } catch { /* leave empty; the panel still renders */ }
    })();
  }, [instanceId]);

  const run = useCallback(async () => {
    if (selId === '' || !query.trim()) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await fetch('/api/datasources/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selId, query, range: canRange && range }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `오류 ${r.status}`);
      setResult(b.result as NormalizedResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '쿼리 실패');
    } finally { setBusy(false); }
  }, [selId, query, range, canRange]);

  // NL → query (AI drafts, user reviews, then runs). Never auto-runs.
  const generate = useCallback(async () => {
    if (selId === '' || !nl.trim()) return;
    setGenBusy(true); setErr('');
    try {
      const r = await fetch('/api/datasources/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selId, nl }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `오류 ${r.status}`);
      if (b.query) setQuery(b.query);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'AI 생성 실패');
    } finally { setGenBusy(false); }
  }, [selId, nl]);

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        {/* Always show the picker (preselected to the scoped instance) — never a dead-end if the
            scoped id isn't in the list yet. */}
        {(
          <div className="flex flex-wrap items-center gap-2">
            <select className={selectCls} value={selId} onChange={(e) => { setSelId(e.target.value ? Number(e.target.value) : ''); setResult(null); setErr(''); }}>
              <option value="">데이터소스 선택…</option>
              {list.map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.kind}){d.isDefault ? ' · 기본' : ''}</option>
              ))}
            </select>
            {canRange && (
              <label className="inline-flex items-center gap-1.5 text-[13px] text-ink-600 select-none">
                <input type="checkbox" checked={range} onChange={(e) => setRange(e.target.checked)} />
                시간 범위 (range)
              </label>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            placeholder={ds ? '자연어로 설명… 예: "모든 노드의 CPU 사용률"' : '먼저 데이터소스를 선택하세요'}
            onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
            disabled={!ds}
          />
          <Button variant="secondary" onClick={generate} disabled={genBusy || !ds || !nl.trim()}>
            {genBusy ? '생성 중…' : 'AI로 생성'}
          </Button>
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
            <span className="text-[12px] text-ink-400">설정된 데이터소스가 없습니다 — Datasources 탭에서 추가하세요.</span>
          )}
        </div>
        {err && <p className="text-[13px] text-rose-600">{err}</p>}
      </Card>
      {result && <ResultView result={result} />}
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
