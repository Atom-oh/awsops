'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Search } from 'lucide-react';
import DataTable, { type Column } from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import PageHeader from '@/components/ui/PageHeader';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Input from '@/components/ui/Input';

type Row = Record<string, unknown>;
type Tab = 'nodes' | 'pods' | 'deployments' | 'services';

const TABS: { value: Tab; label: string }[] = [
  { value: 'nodes', label: 'Nodes' },
  { value: 'pods', label: 'Pods' },
  { value: 'deployments', label: 'Deployments' },
  { value: 'services', label: 'Services' },
];

// Per-kind columns (match the lib's normalized rows). Kinds with a `namespace`
// field get the in-page namespace filter.
const COLUMNS: Record<Tab, Column[]> = {
  nodes: [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
    { key: 'roles', label: 'Roles' },
    { key: 'version', label: 'Version' },
    { key: 'instanceType', label: 'Instance Type' },
    { key: 'zone', label: 'Zone' },
    { key: 'age', label: 'Age' },
  ],
  pods: [
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'status', label: 'Status' },
    { key: 'node', label: 'Node' },
    { key: 'restarts', label: 'Restarts' },
    { key: 'age', label: 'Age' },
  ],
  deployments: [
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'ready', label: 'Ready' },
    { key: 'upToDate', label: 'Up-to-date' },
    { key: 'available', label: 'Available' },
    { key: 'age', label: 'Age' },
  ],
  services: [
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'type', label: 'Type' },
    { key: 'clusterIP', label: 'Cluster IP' },
    { key: 'ports', label: 'Ports' },
    { key: 'age', label: 'Age' },
  ],
};

const NAMESPACED: Set<Tab> = new Set(['pods', 'deployments', 'services']);

export default function EksClusterPage() {
  const params = useParams();
  const cluster = String(params.cluster);

  const [tab, setTab] = useState<Tab>('nodes');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [ns, setNs] = useState('전체');
  const [selected, setSelected] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setErr('');
    try {
      const r = await fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=${tab}`);
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        throw new Error(d?.message ? String(d.message) : String(r.status));
      }
      const d = await r.json();
      setRows(d.rows as Row[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [cluster, tab]);

  // Reset filters when switching kinds, then reload.
  useEffect(() => {
    setQuery('');
    setNs('전체');
    load();
  }, [load]);

  const allRows = useMemo(() => rows ?? [], [rows]);

  // Distinct namespaces (namespaced kinds only) → filter options.
  const nsOptions = useMemo(() => {
    if (!NAMESPACED.has(tab)) return [];
    const set = new Set<string>();
    for (const r of allRows) {
      const v = r.namespace;
      if (v != null && v !== '') set.add(String(v));
    }
    return ['전체', ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [allRows, tab]);

  const filteredRows = useMemo(() => {
    let out = allRows;
    if (NAMESPACED.has(tab) && ns !== '전체') {
      out = out.filter((r) => String(r.namespace ?? '') === ns);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return out;
  }, [allRows, tab, ns, query]);

  return (
    <>
      <PageHeader
        title={cluster}
        subtitle={`EKS · 인-클러스터 리소스 (read-only) · ${allRows.length.toLocaleString()}개`}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        <div className="overflow-x-auto">
          <SegmentedControl options={TABS} value={tab} onChange={(v) => setTab(v as Tab)} />
        </div>

        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
        {!rows && !err && <div className="text-ink-400">로딩 중…</div>}

        {rows && !err && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="w-full max-w-[280px]">
                <Input
                  inputSize="sm"
                  placeholder="검색…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  icon={<Search className="h-3.5 w-3.5" />}
                />
              </div>
              {nsOptions.length > 1 && (
                <div className="overflow-x-auto">
                  <SegmentedControl options={nsOptions} value={ns} onChange={setNs} />
                </div>
              )}
            </div>
            <DataTable columns={COLUMNS[tab]} rows={filteredRows} onRowClick={setSelected} />
          </>
        )}
      </div>
      <DetailPanel
        title={selected?.name as string | undefined}
        data={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
