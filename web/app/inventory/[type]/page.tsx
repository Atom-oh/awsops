'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Search } from 'lucide-react';
import DataTable from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import RefreshButton from '@/components/ui/RefreshButton';
import PageHeader from '@/components/ui/PageHeader';
import StatTile from '@/components/ui/StatTile';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Input from '@/components/ui/Input';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import RiskHero from '@/components/inventory/RiskHero';
import { INVENTORY_TYPES, HIGHLIGHTS, computeHighlights, layoutOf } from '@/lib/inventory-types';

type Row = Record<string, unknown>;

// Lifecycle values treated as degraded → render their KPI tile in the danger variant.
const BAD_STATES = new Set([
  'stopped', 'stopping', 'failed', 'crashloopbackoff', 'alarm', 'impaired',
  'inactive', 'deleting', 'deleted', 'error', 'unhealthy', 'terminated',
]);

function stateVariant(value: string): 'default' | 'danger' {
  return BAD_STATES.has(value.trim().toLowerCase()) ? 'danger' : 'default';
}

// Count rows by a column value (stringified), descending by count.
function countBy(rows: Row[], key: string): { name: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const raw = r[key];
    const name = raw == null || raw === '' ? '(none)' : String(raw);
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export default function InventoryTypePage() {
  const params = useParams();
  const type = String(params.type);
  const spec = INVENTORY_TYPES[type];

  const [rows, setRows] = useState<Row[] | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('전체');
  const [selected, setSelected] = useState<Row | null>(null);
  // Supplementary metric KPI cards (e.g. EC2 avg CPU + hourly cost). Degrade silently to [].
  const [metricCards, setMetricCards] = useState<{ label: string; value: string | number; accent?: boolean }[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/inventory/${type}`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setRows((d.rows as Row[]).map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data as object) })));
      setCaptured(d.run?.finished_at ?? null);
    } catch (e) { setErr(String(e)); }
  }, [type]);
  useEffect(() => { if (spec) load(); }, [spec, load]);

  // Supplementary metric cards — fetch separately so a failure never affects the table/donut.
  useEffect(() => {
    setMetricCards([]);
    if (!spec) return;
    let alive = true;
    fetch(`/api/inventory/${type}/metrics`)
      .then((r) => (r.ok ? r.json() : { cards: [] }))
      .then((d) => { if (alive) setMetricCards(d.cards || []); })
      .catch(() => { if (alive) setMetricCards([]); });
    return () => { alive = false; };
  }, [spec, type]);

  const refresh = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/inventory/${type}/refresh`, { method: 'POST' });
      if (!r.ok) throw new Error(r.status === 401 ? '세션 만료 — 새로고침' : `수집 실패 (${r.status})`);
      await load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const allRows = useMemo(() => rows ?? [], [rows]);

  // KPI state breakdown — from the FULL row set (not filtered).
  const stateCounts = useMemo(
    () => (spec?.stateKey ? countBy(allRows, spec.stateKey) : []),
    [allRows, spec?.stateKey],
  );

  // Per-type highlight cards (tailored top KPIs from synced columns). Empty → fall
  // back to the generic state tiles, so unconfigured types render as before.
  const highlightCards = useMemo(
    () => (HIGHLIGHTS[type] ? computeHighlights(allRows, HIGHLIGHTS[type]) : []),
    [allRows, type],
  );

  // Distribution donut — top 6 + 기타, from the FULL row set.
  const distData = useMemo(() => {
    if (!spec?.distKey) return [];
    const counts = countBy(allRows, spec.distKey);
    if (counts.length <= 6) return counts;
    const head = counts.slice(0, 6);
    const rest = counts.slice(6).reduce((acc, c) => acc + c.value, 0);
    return rest > 0 ? [...head, { name: '기타', value: rest }] : head;
  }, [allRows, spec?.distKey]);

  // Filters narrow ONLY the displayed table rows.
  const filteredRows = useMemo(() => {
    let out = allRows;
    if (spec?.stateKey && stateFilter !== '전체') {
      out = out.filter((r) => {
        const v = r[spec.stateKey as string];
        const name = v == null || v === '' ? '(none)' : String(v);
        return name === stateFilter;
      });
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return out;
  }, [allRows, spec?.stateKey, stateFilter, query]);

  if (!spec) {
    return (
      <>
        <PageHeader title="Inventory" />
        <div className="px-8 py-8">
          <div className="text-[13px] text-rose-600">Unknown inventory type: {type}</div>
        </div>
      </>
    );
  }

  const columns = [{ key: 'resource_id', label: 'ID' }, { key: 'region', label: 'Region' }, ...spec.columns];
  const colLabel = (key?: string) =>
    (key && spec.columns.find((c) => c.key === key)?.label) || key || '';
  const distLabel = colLabel(spec.distKey);
  const stateOptions = ['전체', ...stateCounts.map((s) => s.name)];
  const arch = layoutOf(type);

  // Composable section blocks — arranged per archetype in the render below.
  const kpiRow = (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <StatTile label={`총 ${spec.label}`} value={allRows.length} variant="accent" />
      {highlightCards.length > 0
        ? highlightCards.map((h) => <StatTile key={h.label} label={h.label} value={h.value} variant={h.variant} />)
        : stateCounts.slice(0, 4).map((s) => <StatTile key={s.name} label={s.name} value={s.value} variant={stateVariant(s.name)} />)}
      {metricCards.map((c) => <StatTile key={c.label} label={c.label} value={c.value} variant="accent" />)}
    </div>
  );
  const donut = spec.distKey && distData.length > 0
    ? <DonutBreakdown title={`${distLabel} 분포`} data={distData} nameKey="name" valueKey="value" />
    : null;
  const tableBlock = (
    <div className="flex flex-col gap-3">
      <Filters query={query} onQuery={setQuery} stateOptions={spec.stateKey ? stateOptions : undefined} stateFilter={stateFilter} onState={setStateFilter} />
      <DataTable columns={columns} rows={filteredRows} onRowClick={setSelected} />
    </div>
  );

  return (
    <>
      <PageHeader
        title={spec.label}
        subtitle={`${spec.group} · ${allRows.length.toLocaleString()}개 리소스`}
        right={<RefreshButton busy={busy} onClick={refresh} capturedAt={captured} />}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">{err}</div>}
        {!rows && !err && <div className="text-ink-400">로딩 중…</div>}

        {rows && (
          <>
            {arch === 'risk' ? (
              /* Security posture: verdict hero → table → compact donut. */
              <>
                <RiskHero label={spec.label} total={allRows.length} cards={highlightCards} />
                {metricCards.length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    {metricCards.map((c) => <StatTile key={c.label} label={c.label} value={c.value} variant="accent" />)}
                  </div>
                )}
                {tableBlock}
                {donut && <div className="lg:max-w-md">{donut}</div>}
              </>
            ) : arch === 'chart' && donut ? (
              /* Utilization/state: KPIs → prominent full-width distribution → table. */
              <>
                {kpiRow}
                {donut}
                {tableBlock}
              </>
            ) : arch === 'capacity' && donut ? (
              /* Engine/type/size: KPIs → donut beside the table. */
              <>
                {kpiRow}
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-6 items-start">
                  {donut}
                  {tableBlock}
                </div>
              </>
            ) : (
              /* directory (+ any archetype without a distribution): scan-first. */
              <>
                {kpiRow}
                {tableBlock}
                {donut && <div className="lg:max-w-sm">{donut}</div>}
              </>
            )}
          </>
        )}
      </div>
      <DetailPanel
        title={selected?.resource_id as string | undefined}
        data={selected}
        spec={spec}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

// Search + (optional) state SegmentedControl — narrow the table only.
function Filters({
  query,
  onQuery,
  stateOptions,
  stateFilter,
  onState,
}: {
  query: string;
  onQuery: (v: string) => void;
  stateOptions?: string[];
  stateFilter: string;
  onState: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="w-full max-w-[280px]">
        <Input
          inputSize="sm"
          placeholder="검색…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          icon={<Search className="h-3.5 w-3.5" />}
        />
      </div>
      {stateOptions && stateOptions.length > 1 && (
        <div className="overflow-x-auto">
          <SegmentedControl options={stateOptions} value={stateFilter} onChange={onState} />
        </div>
      )}
    </div>
  );
}
