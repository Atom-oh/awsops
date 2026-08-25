'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Plus, Trash2, Pencil } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import PolicyGraph from '@/components/graph/PolicyGraph';
import { useI18n } from '@/components/shell/LanguageProvider';
import { buildNetworkPathGraph } from '@/lib/network-path-graph';
import type { NetworkPathCheckRow, NetworkPathRunRow, NetworkPathRunDetail } from '@/lib/network-path';

// /network-paths — Network Path Check (docs/superpowers/specs/2026-08-13-network-path-check-design.md).
// Top-level Network menu entry (not nested under Security Group, per spec). The resolved-path
// PolicyGraph is the PRIMARY result; the layer checklist beside it (rendered straight from
// `steps`, grouped by candidate) is the accessible textual source of truth — the spec is explicit
// that AWSops never executes the validation bundle, so it only ever renders as read-only text here.

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const POLL_MS = 3000;

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-8 py-16 text-center text-[14px] text-ink-400">{message}</div>
  );
}

// ── Structured source/destination/request selector ────────────────────────────────────────────
//
// Wire format built here matches the existing `NetworkPathDefinition` contract (source/destination/
// request each an arbitrary JSON object — see lib/network-path.ts's validateDefinition, which only
// checks the three keys are objects). No API/DB shape change was needed: this only replaces the
// free-form JSON textarea UX with typed fields that assemble the same kind of plain object. The
// concrete shapes below follow the spec's "Supported endpoints" list (source: EKS Pod/Node;
// destination: AWS resource / internet IP-or-URL / on-prem IP-or-URL) and "Result semantics" section.
type SourceKind = 'eks_pod' | 'eks_node';
type DestKind = 'aws_resource' | 'internet' | 'on_prem';
type Protocol = 'tcp' | 'udp' | 'icmp';

interface FormState {
  name: string;
  sourceAccountId: string;
  sourceKind: SourceKind;
  sourceCluster: string;
  sourceNamespace: string;
  sourcePodName: string;
  sourceNodeName: string;
  destKind: DestKind;
  destResourceId: string;
  destHost: string;
  destPath: string;
  onPremHost: string;
  protocol: Protocol;
  port: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  sourceAccountId: '',
  sourceKind: 'eks_pod',
  sourceCluster: '',
  sourceNamespace: '',
  sourcePodName: '',
  sourceNodeName: '',
  destKind: 'aws_resource',
  destResourceId: '',
  destHost: '',
  destPath: '',
  onPremHost: '',
  protocol: 'tcp',
  port: '443',
};

/** Best-effort inverse of buildDefinition() — used to pre-fill the edit form from a saved check. */
function formStateFromCheck(check: NetworkPathCheckRow): FormState {
  const d = check.definition ?? { source: {}, destination: {}, request: {} };
  const s = (d.source ?? {}) as Record<string, unknown>;
  const dest = (d.destination ?? {}) as Record<string, unknown>;
  const req = (d.request ?? {}) as Record<string, unknown>;
  const sourceKind: SourceKind = s.kind === 'eks_node' ? 'eks_node' : 'eks_pod';
  const destKind: DestKind = dest.kind === 'internet' || dest.kind === 'on_prem' ? (dest.kind as DestKind) : 'aws_resource';
  return {
    name: check.name,
    sourceAccountId: check.source_account_id,
    sourceKind,
    sourceCluster: typeof s.cluster === 'string' ? s.cluster : '',
    sourceNamespace: typeof s.namespace === 'string' ? s.namespace : '',
    sourcePodName: typeof s.pod_name === 'string' ? s.pod_name : '',
    sourceNodeName: typeof s.node_name === 'string' ? s.node_name : '',
    destResourceId: typeof dest.resource_id === 'string' ? dest.resource_id : '',
    destHost: destKind === 'internet' && typeof dest.host === 'string' ? dest.host : '',
    destPath: typeof dest.path === 'string' ? dest.path : '',
    onPremHost: destKind === 'on_prem' && typeof dest.host === 'string' ? dest.host : '',
    destKind,
    protocol: req.protocol === 'udp' || req.protocol === 'icmp' ? req.protocol : 'tcp',
    port: typeof req.port === 'number' ? String(req.port) : '',
  };
}

function buildDefinition(f: FormState) {
  const source =
    f.sourceKind === 'eks_pod'
      ? { kind: 'eks_pod', cluster: f.sourceCluster, namespace: f.sourceNamespace, pod_name: f.sourcePodName }
      : { kind: 'eks_node', cluster: f.sourceCluster, node_name: f.sourceNodeName };

  const destination =
    f.destKind === 'aws_resource'
      ? { kind: 'aws_resource', resource_id: f.destResourceId }
      : f.destKind === 'internet'
      ? { kind: 'internet', host: f.destHost, ...(f.destPath ? { path: f.destPath } : {}) }
      : { kind: 'on_prem', host: f.onPremHost };

  const request: Record<string, unknown> = { protocol: f.protocol };
  if (f.protocol !== 'icmp' && f.port.trim()) request.port = Number(f.port);
  if (f.destKind === 'internet' && f.destPath) request.path = f.destPath;

  return { source, destination, request };
}

const selectClass = 'rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]';
const inputClass = 'rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]';

function CheckForm({
  existing,
  onSaved,
  onCancel,
}: {
  existing?: NetworkPathCheckRow;
  onSaved: (saved: NetworkPathCheckRow) => void;
  onCancel: () => void;
}) {
  const { tt } = useI18n();
  const [f, setF] = useState<FormState>(() => (existing ? formStateFromCheck(existing) : EMPTY_FORM));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((prev) => ({ ...prev, [key]: value }));

  const isHttpish = f.destKind === 'internet' && f.protocol === 'tcp';

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const definition = buildDefinition(f);
      const body = { name: f.name, source_account_id: f.sourceAccountId, definition };
      const r = existing
        ? await fetch(`/api/network-paths/${existing.id}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: body.name, definition }),
          })
        : await fetch('/api/network-paths', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
      onSaved(d.check);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Card title={existing ? tt('경로 점검 정의 수정') : tt('새 경로 점검 정의')} padded>
      <div className="flex flex-col gap-3">
        <input placeholder={tt('이름')} value={f.name} onChange={(e) => set('name', e.target.value)} className={inputClass} />
        <input
          placeholder={tt('소스 계정 ID (12자리)')}
          value={f.sourceAccountId}
          disabled={!!existing}
          onChange={(e) => set('sourceAccountId', e.target.value)}
          className={`${inputClass} disabled:opacity-50`}
        />

        <div className="flex flex-col gap-1.5 rounded-md border border-ink-100 p-2">
          <div className="text-[11px] font-semibold uppercase text-ink-400">{tt('소스 (Source)')}</div>
          <select aria-label={tt('소스 종류')} value={f.sourceKind} onChange={(e) => set('sourceKind', e.target.value as SourceKind)} className={selectClass}>
            <option value="eks_pod">{tt('EKS Pod')}</option>
            <option value="eks_node">{tt('EKS Node')}</option>
          </select>
          <input placeholder={tt('클러스터')} value={f.sourceCluster} onChange={(e) => set('sourceCluster', e.target.value)} className={inputClass} />
          {f.sourceKind === 'eks_pod' ? (
            <>
              <input placeholder={tt('네임스페이스')} value={f.sourceNamespace} onChange={(e) => set('sourceNamespace', e.target.value)} className={inputClass} />
              <input placeholder={tt('Pod 이름')} value={f.sourcePodName} onChange={(e) => set('sourcePodName', e.target.value)} className={inputClass} />
            </>
          ) : (
            <input placeholder={tt('노드 이름')} value={f.sourceNodeName} onChange={(e) => set('sourceNodeName', e.target.value)} className={inputClass} />
          )}
        </div>

        <div className="flex flex-col gap-1.5 rounded-md border border-ink-100 p-2">
          <div className="text-[11px] font-semibold uppercase text-ink-400">{tt('목적지 (Destination)')}</div>
          <select aria-label={tt('목적지 종류')} value={f.destKind} onChange={(e) => set('destKind', e.target.value as DestKind)} className={selectClass}>
            <option value="aws_resource">{tt('AWS 리소스')}</option>
            <option value="internet">{tt('인터넷 IP 또는 URL')}</option>
            <option value="on_prem">{tt('온프레미스 (VPN/DX)')}</option>
          </select>
          {f.destKind === 'aws_resource' && (
            <input placeholder={tt('리소스 ARN 또는 ID')} value={f.destResourceId} onChange={(e) => set('destResourceId', e.target.value)} className={inputClass} />
          )}
          {f.destKind === 'internet' && (
            <input placeholder={tt('호스트 또는 IP/URL')} value={f.destHost} onChange={(e) => set('destHost', e.target.value)} className={inputClass} />
          )}
          {f.destKind === 'on_prem' && (
            <input placeholder={tt('온프레미스 IP 또는 URL')} value={f.onPremHost} onChange={(e) => set('onPremHost', e.target.value)} className={inputClass} />
          )}
        </div>

        <div className="flex flex-col gap-1.5 rounded-md border border-ink-100 p-2">
          <div className="text-[11px] font-semibold uppercase text-ink-400">{tt('요청 (Request)')}</div>
          <select aria-label={tt('프로토콜')} value={f.protocol} onChange={(e) => set('protocol', e.target.value as Protocol)} className={selectClass}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="icmp">ICMP</option>
          </select>
          {f.protocol !== 'icmp' && (
            <input placeholder={tt('포트')} inputMode="numeric" value={f.port} onChange={(e) => set('port', e.target.value)} className={inputClass} />
          )}
          {isHttpish && (
            <input placeholder={tt('경로 (선택, 예: /health)')} value={f.destPath} onChange={(e) => set('destPath', e.target.value)} className={inputClass} />
          )}
        </div>

        {err && <div className="text-[12px] text-rose-600">{err}</div>}
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={submit} className="rounded-md bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50">
            {existing ? tt('저장') : tt('생성')}
          </button>
          <button type="button" onClick={onCancel} className="rounded-md border border-ink-200 px-3 py-1.5 text-[12px]">{tt('취소')}</button>
        </div>
      </div>
    </Card>
  );
}

function ChecklistTable({ run }: { run: NetworkPathRunDetail }) {
  const { tt } = useI18n();
  const byCandidate = useMemo(() => {
    const m = new Map<string, typeof run.steps>();
    for (const s of run.steps) m.set(s.candidate_id, [...(m.get(s.candidate_id) ?? []), s]);
    return m;
  }, [run.steps]);

  return (
    <div className="flex flex-col gap-3">
      {run.candidates.map((c) => (
        <div key={c.candidate_id} className="rounded-md border border-ink-100 p-2">
          <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold">
            {c.candidate_kind} ({c.candidate_id})
            <Badge tone={c.status === 'allowed' ? 'positive' : c.status === 'blocked' ? 'negative' : 'neutral'} variant="soft">
              {c.status ?? tt('실행 중')}
            </Badge>
          </div>
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-ink-400"><th>Layer</th><th>Status</th><th>Resource</th><th>Summary</th></tr></thead>
            <tbody>
              {(byCandidate.get(c.candidate_id) ?? []).sort((a, b) => a.ordinal - b.ordinal).map((s) => (
                <tr key={`${s.candidate_id}-${s.ordinal}`} className="border-t border-ink-50">
                  <td className="py-1">{s.layer}</td>
                  <td>
                    {/* not_run rendered distinctly from unknown — never collapsed together. */}
                    <Badge
                      tone={s.status === 'allowed' ? 'positive' : s.status === 'blocked' ? 'negative' : s.status === 'not_run' ? 'neutral' : 'brand'}
                      variant={s.status === 'not_run' ? 'outline' : 'soft'}
                    >
                      {s.status === 'not_run' ? tt('실행 안 됨') : s.status === 'unknown' ? tt('알 수 없음') : s.status}
                    </Badge>
                  </td>
                  <td className="font-mono text-[11px]">{s.resource ?? '—'}</td>
                  <td className="text-ink-600">{s.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function ValidationBundle({ bundle }: { bundle: unknown }) {
  const { tt } = useI18n();
  if (bundle == null) return null;
  return (
    <Card title={tt('검증 명령어 (읽기 전용)')} subtitle={tt('AWSops는 이 명령을 실행하지 않습니다 — 복사해서 직접 실행하세요')}>
      <pre className="max-h-64 overflow-auto rounded bg-ink-50 p-2 text-[11px] text-ink-700">
        {typeof bundle === 'string' ? bundle : JSON.stringify(bundle, null, 2)}
      </pre>
    </Card>
  );
}

export default function NetworkPathsPage() {
  const { tt } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [checks, setChecks] = useState<NetworkPathCheckRow[]>([]);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingCheck, setEditingCheck] = useState<NetworkPathCheckRow | null>(null);
  const [selectedCheck, setSelectedCheck] = useState<NetworkPathCheckRow | null>(null);
  const [runs, setRuns] = useState<NetworkPathRunRow[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<NetworkPathRunDetail | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareRuns, setCompareRuns] = useState<NetworkPathRunDetail[]>([]);
  const [me, setMe] = useState<{ sub: string; isAdmin: boolean } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadChecks = useCallback(async () => {
    try {
      const r = await fetch('/api/network-paths');
      if (r.status === 503) { setEnabled(false); return; }
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
      setEnabled(true);
      setChecks(d.checks ?? []);
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { loadChecks(); }, [loadChecks]);
  useEffect(() => {
    fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setMe({ sub: d.sub, isAdmin: !!d.isAdmin }); }).catch(() => {});
  }, []);

  const loadRuns = useCallback(async (checkId: string) => {
    const r = await fetch(`/api/network-paths/${checkId}/runs`);
    const d = await r.json().catch(() => null);
    if (r.ok) setRuns(d.runs ?? []);
  }, []);

  const selectCheck = (c: NetworkPathCheckRow) => {
    setSelectedCheck(c);
    setActiveRunId(null);
    setRunDetail(null);
    setCompareIds([]);
    setCompareRuns([]);
    loadRuns(c.id);
  };

  const runCheck = async () => {
    if (!selectedCheck) return;
    const r = await fetch(`/api/network-paths/${selectedCheck.id}/runs`, { method: 'POST' });
    const d = await r.json().catch(() => null);
    if (r.ok && d?.run?.id) {
      setActiveRunId(d.run.id);
      loadRuns(selectedCheck.id);
    }
  };

  const deleteCheck = async (c: NetworkPathCheckRow) => {
    const r = await fetch(`/api/network-paths/${c.id}`, { method: 'DELETE' });
    if (r.ok) {
      setChecks((prev) => prev.filter((x) => x.id !== c.id));
      if (selectedCheck?.id === c.id) setSelectedCheck(null);
    } else {
      const d = await r.json().catch(() => null);
      setErr(d?.message ?? tt('삭제 실패'));
    }
  };

  // Poll the active run until it reaches a terminal status.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (!activeRunId) return;
    const fetchOnce = async () => {
      const r = await fetch(`/api/network-path-runs/${activeRunId}`);
      const d = await r.json().catch(() => null);
      if (r.ok) {
        setRunDetail(d.run);
        if (TERMINAL.has(d.run.status) && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    };
    fetchOnce();
    pollRef.current = setInterval(fetchOnce, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeRunId]);

  const graphResult = useMemo(() => (runDetail ? buildNetworkPathGraph(runDetail) : null), [runDetail]);

  const toggleCompare = (id: string) => setCompareIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 2 ? [...prev, id] : [prev[1], id]));

  useEffect(() => {
    if (compareIds.length !== 2) { setCompareRuns([]); return; }
    Promise.all(compareIds.map((id) => fetch(`/api/network-path-runs/${id}`).then((r) => (r.ok ? r.json() : null))))
      .then((rs) => setCompareRuns(rs.filter(Boolean).map((r) => r.run)));
  }, [compareIds]);

  if (enabled === false) {
    return (
      <>
        <PageHeader title={tt('경로 점검')} />
        <EmptyState message={tt('이 기능은 현재 비활성화되어 있습니다 (network_path_check_enabled=false).')} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={tt('경로 점검')}
        subtitle={tt('저장된 경로 점검 정의를 실행하고 결과 그래프 + 계층 체크리스트로 확인합니다')}
        right={
          <button type="button" onClick={() => { setEditingCheck(null); setCreating((v) => !v); }} className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-white">
            <Plus size={13} />{tt('새 점검')}
          </button>
        }
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">{err}</div>}
        {creating && (
          <CheckForm onSaved={() => { setCreating(false); loadChecks(); }} onCancel={() => setCreating(false)} />
        )}
        {editingCheck && (
          <CheckForm
            existing={editingCheck}
            onSaved={(saved) => {
              setEditingCheck(null);
              loadChecks();
              setSelectedCheck((prev) => (prev && prev.id === saved.id ? saved : prev));
            }}
            onCancel={() => setEditingCheck(null)}
          />
        )}

        {enabled && checks.length === 0 && !creating && (
          <EmptyState message={tt('저장된 경로 점검이 없습니다 — 새 점검을 만들어 보세요.')} />
        )}

        {checks.length > 0 && (
          <Card title={tt('저장된 점검')} padded={false}>
            <ul>
              {checks.map((c) => {
                const canEdit = !!me && (me.isAdmin || me.sub === c.created_by_sub);
                return (
                  <li key={c.id} className={`flex items-center justify-between gap-2 border-b border-ink-50 px-4 py-2 last:border-0 ${selectedCheck?.id === c.id ? 'bg-brand-50' : ''}`}>
                    <button type="button" onClick={() => selectCheck(c)} className="min-w-0 flex-1 text-left text-[13px]">
                      <span className="font-medium">{c.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-ink-400">{c.source_account_id}</span>
                    </button>
                    {canEdit && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          title={tt('수정')}
                          onClick={() => { setCreating(false); setEditingCheck(c); }}
                          className="rounded p-1 text-ink-400 hover:text-ink-700"
                        >
                          <Pencil size={13} />
                        </button>
                        <button type="button" title={tt('삭제')} onClick={() => deleteCheck(c)} className="rounded p-1 text-ink-400 hover:text-rose-600"><Trash2 size={13} /></button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {selectedCheck && (
          <Card
            title={selectedCheck.name}
            subtitle={tt('소스 계정')}
            right={
              <button type="button" onClick={runCheck} className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-white">
                <Play size={13} />{tt('실행')}
              </button>
            }
          >
            <div className="flex flex-col gap-4">
              {runs.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase text-ink-400">{tt('실행 이력')}</div>
                  <ul className="flex flex-col gap-1">
                    {runs.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 text-[12px]">
                        <input type="checkbox" checked={compareIds.includes(r.id)} onChange={() => toggleCompare(r.id)} aria-label={tt('비교 선택')} />
                        <button type="button" onClick={() => setActiveRunId(r.id)} className={`flex-1 text-left ${activeRunId === r.id ? 'font-semibold text-brand-700' : ''}`}>
                          {r.created_at} — {r.status}{r.overall_status ? ` (${r.overall_status})` : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {runDetail && graphResult && (
                <div className="flex flex-col gap-4 lg:flex-row">
                  <div className="h-[420px] flex-1 rounded-lg border border-ink-100">
                    <PolicyGraph graph={graphResult.graph} runningIds={graphResult.runningIds} />
                  </div>
                  <div className="flex-1 overflow-auto">
                    <ChecklistTable run={runDetail} />
                  </div>
                </div>
              )}

              {runDetail?.validation_bundle != null && <ValidationBundle bundle={runDetail.validation_bundle} />}

              {compareRuns.length === 2 && (
                <Card title={tt('실행 비교')}>
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-ink-400"><th></th><th>{compareRuns[0].id}</th><th>{compareRuns[1].id}</th></tr></thead>
                    <tbody>
                      <tr><td className="font-medium">{tt('전체 상태')}</td><td>{compareRuns[0].overall_status ?? '—'}</td><td>{compareRuns[1].overall_status ?? '—'}</td></tr>
                      {[...new Set([...compareRuns[0].steps, ...compareRuns[1].steps].map((s) => s.layer))].map((layer) => {
                        const a = compareRuns[0].steps.find((s) => s.layer === layer);
                        const b = compareRuns[1].steps.find((s) => s.layer === layer);
                        return (
                          <tr key={layer} className={a?.status !== b?.status ? 'bg-amber-50' : undefined}>
                            <td>{layer}</td><td>{a?.status ?? '—'}</td><td>{b?.status ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
