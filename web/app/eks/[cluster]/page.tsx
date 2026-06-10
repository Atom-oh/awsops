'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import DataTable, { type Column } from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import PageHeader from '@/components/ui/PageHeader';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Input from '@/components/ui/Input';
import Badge from '@/components/ui/Badge';

type Row = Record<string, unknown>;
type Tab = 'nodes' | 'pods' | 'deployments' | 'services' | 'diagnosis';

const TABS: { value: Tab; label: string }[] = [
  { value: 'nodes', label: 'Nodes' },
  { value: 'pods', label: 'Pods' },
  { value: 'deployments', label: 'Deployments' },
  { value: 'services', label: 'Services' },
  { value: 'diagnosis', label: 'Diagnosis' },
];

// ADR-035 Rule 7: the deterministic K8sGPT analyzer fact (FACT half).
interface AnalyzerResult {
  analyzer: string;
  resourceName: string;
  namespace: string;
  errors: string[];
  details: string;
  parentObject: string;
}
// ADR-035 Rule 8: analyzer_result (FACT) is kept structurally separate from
// llm_explanation (HYPOTHESIS — Haiku narration, may be null).
interface DiagnosisFinding {
  analyzer_result: AnalyzerResult;
  llm_explanation: string | null;
  llm_model: string | null;
}
interface DiagnosisResult {
  enabled: boolean;
  stale: boolean;
  operator_detected?: boolean;
  findings: DiagnosisFinding[];
}

// Per-kind columns (match the lib's normalized rows). Kinds with a `namespace`
// field get the in-page namespace filter. Diagnosis uses DIAGNOSIS_COLUMNS.
const COLUMNS: Record<Exclude<Tab, 'diagnosis'>, Column[]> = {
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

// ADR-035 Rule 8: the table surfaces ONLY the deterministic facts. The AI
// hypothesis (llm_explanation) is shown distinctly in the detail panel below.
const DIAGNOSIS_COLUMNS: Column[] = [
  { key: 'analyzer', label: 'Analyzer' },
  { key: 'resourceName', label: 'Resource' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'errors', label: 'Finding (deterministic)' }, // Rule 8 FACT
];

const NAMESPACED: Set<Tab> = new Set(['pods', 'deployments', 'services']);

export default function EksClusterPage() {
  const params = useParams();
  const cluster = String(params.cluster);

  const [tab, setTab] = useState<Tab>('nodes');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [diag, setDiag] = useState<DiagnosisResult | null>(null);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [ns, setNs] = useState('전체');
  const [selected, setSelected] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setDiag(null);
    setErr('');
    try {
      // ADR-035: the diagnosis endpoint returns {enabled,stale,findings:[...]},
      // NOT {rows}. 503 (flag off) → degrade-safe disabled state, no thrown error.
      if (tab === 'diagnosis') {
        const r = await fetch(`/api/eks/${encodeURIComponent(cluster)}/k8sgpt`);
        if (r.status === 503) {
          setDiag({ enabled: false, stale: true, findings: [] });
          return;
        }
        if (!r.ok) {
          const d = await r.json().catch(() => null);
          throw new Error(d?.message ? String(d.message) : String(r.status));
        }
        setDiag((await r.json()) as DiagnosisResult);
        return;
      }
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

  // ADR-035 Step 1: map each deterministic finding to a table row. The table
  // shows only the FACT columns; the full finding rides along under `_finding`
  // so the detail panel can render the HYPOTHESIS distinctly (Rule 8).
  const diagnosisRows = useMemo<Row[]>(() => {
    if (!diag) return [];
    return diag.findings.map((f) => ({
      analyzer: f.analyzer_result.analyzer,
      resourceName: f.analyzer_result.resourceName,
      namespace: f.analyzer_result.namespace,
      errors: f.analyzer_result.errors.join('; '),
      hypothesis: f.llm_explanation ?? '—',
      _finding: f,
    }));
  }, [diag]);

  const selectedFinding =
    selected && selected._finding ? (selected._finding as DiagnosisFinding) : null;

  const isDiagnosis = tab === 'diagnosis';
  // ADR-035 Rule 9: disabled (503/enabled:false) or zero findings → quiet,
  // degrade-safe state. No operator detected reads the same.
  const diagDisabled = !!diag && (!diag.enabled || diag.findings.length === 0);

  return (
    <>
      <PageHeader
        title={cluster}
        subtitle={
          isDiagnosis
            ? 'EKS · K8sGPT 진단 (read-only) · AI 가설은 검증 후 조치'
            : `EKS · 인-클러스터 리소스 (read-only) · ${allRows.length.toLocaleString()}개`
        }
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        <div className="overflow-x-auto">
          <SegmentedControl options={TABS} value={tab} onChange={(v) => setTab(v as Tab)} />
        </div>

        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}

        {isDiagnosis ? (
          <>
            {!diag && !err && <div className="text-ink-400">로딩 중…</div>}
            {diag && !err && (
              <>
                {/* Rule 9: stale (operator down/slow, last scan > threshold) banner. */}
                {diag.enabled && diag.stale && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                    last scan stale (&gt;5m)
                  </div>
                )}
                {diagDisabled ? (
                  <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
                    진단 비활성 또는 K8sGPT operator 미감지 (read-only)
                  </div>
                ) : (
                  <DataTable
                    columns={DIAGNOSIS_COLUMNS}
                    rows={diagnosisRows}
                    onRowClick={setSelected}
                  />
                )}
              </>
            )}
          </>
        ) : (
          <>
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
                <DataTable
                  columns={COLUMNS[tab as Exclude<Tab, 'diagnosis'>]}
                  rows={filteredRows}
                  onRowClick={setSelected}
                />
              </>
            )}
          </>
        )}
      </div>

      {/* Diagnosis detail: deterministic FACTS + a visually distinct, badged AI
          HYPOTHESIS block (Rule 8). The generic DetailPanel can't surface that
          fact/hypothesis split, so diagnosis rows get a dedicated panel. */}
      {selectedFinding ? (
        <DiagnosisDetailPanel finding={selectedFinding} onClose={() => setSelected(null)} />
      ) : (
        <DetailPanel
          title={selected?.name as string | undefined}
          data={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/**
 * DiagnosisDetailPanel — ADR-035 Rule 8 surface. Shows the DETERMINISTIC
 * analyzer_result facts (high confidence) and, in a visually distinct block
 * below, the Haiku narration explicitly badged as an UNVERIFIED hypothesis.
 * Read-only: nothing here mutates the cluster.
 */
function DiagnosisDetailPanel({
  finding,
  onClose,
}: {
  finding: DiagnosisFinding;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const r = finding.analyzer_result;
  const facts: { label: string; value: string }[] = [
    { label: 'analyzer', value: r.analyzer },
    { label: 'resource', value: r.resourceName },
    { label: 'namespace', value: r.namespace },
    { label: 'errors', value: r.errors.join('\n') },
    { label: 'details', value: r.details },
    { label: 'parentObject', value: r.parentObject },
  ];

  return (
    <>
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-40 bg-ink-900/20" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={r.resourceName || '진단 상세'}
        className="fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-full flex-col border-l border-ink-100 bg-white shadow-pop"
      >
        <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <h2 className="min-w-0 break-words font-mono text-[13px] font-semibold text-ink-800">
            {r.resourceName || '진단 상세'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="-mr-1 shrink-0 rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* FACT half — deterministic K8sGPT analyzer result (Rule 8). */}
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="neutral" variant="outline">
              deterministic fact
            </Badge>
          </div>
          <dl className="space-y-2.5">
            {facts.map((f) => (
              <div key={f.label} className="grid grid-cols-1 gap-0.5">
                <dt className="font-mono text-[11px] text-ink-500">{f.label}</dt>
                <dd className="text-[13px] text-ink-800">
                  {f.value ? (
                    <span className="block whitespace-pre-wrap break-words select-text">{f.value}</span>
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {/* HYPOTHESIS half — Haiku narration, explicitly labelled UNVERIFIED. */}
          <div className="mt-5 rounded-md border border-claude-200 bg-claude-50 px-3 py-3">
            <div className="mb-1.5">
              <Badge tone="brand" variant="solid">
                AI hypothesis (Haiku) — verify before acting
              </Badge>
            </div>
            <p className="text-[13px] leading-snug text-ink-700 whitespace-pre-wrap break-words select-text">
              {finding.llm_explanation ?? '가설 없음 (deterministic finding only)'}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
