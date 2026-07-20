'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Container, CheckCircle2, Server, Boxes, Layers, Network } from 'lucide-react';
import Link from 'next/link';
import DataTable from '@/components/ui/DataTable';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import Badge from '@/components/ui/Badge';
import StatCard from '@/components/ui/StatCard';
import { useActiveAccount, accountParam } from '@/lib/account-context';
import Card from '@/components/ui/Card';
import Meter from '@/components/ui/Meter';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import BarDistribution from '@/components/charts/BarDistribution';

// EKS fleet overview — v1 /k8s-Overview parity. Access Entry holders register
// instantly (the v2 equivalent of v1's "Register kubeconfig"); others get the
// v1-style CLI onboarding guide. Clusters render as cards (not table rows) with
// node resource bars, pod charts and warning events from the live fleet endpoint.

interface Cluster {
  name: string; status?: string; version?: string; region?: string;
  vpcId?: string; platformVersion?: string;
  access: 'connected' | 'entry-only' | 'no-entry' | 'unknown';
  runtime?: boolean;
  guide?: Guide;
}
interface Guide { commands: string[]; note: string }

interface NodeAgg {
  name: string;
  instanceType: string;
  cpuAllocatable: number; cpuRequest: number; cpuPct: number;
  memAllocatable: number; memRequest: number; memPct: number;
  diskAllocatable: number; diskRequest: number; diskPct: number;
  podCount: number;
}
interface FleetEvent {
  kind: string; object: string; reason: string; message: string;
  count: number; lastSeen: string; lastSeenTs: number;
}
interface FleetCluster {
  name: string; reachable: boolean;
  counts: { nodes: number; nodesReady: number; pods: number; podsRunning: number; deployments: number; services: number };
  nodeAgg: NodeAgg[];
  instanceTypes: Array<{ type: string; count: number }>;
  podStatus: Record<string, number>;
  podsByNamespace: Array<{ namespace: string; count: number }>;
  events: FleetEvent[];
}

// [PR#40 review MINOR] readable size: GiB at/above 1 GiB, else MiB (avoids tiny nodes showing "0.7").
const fmtMib = (mib: number): string => (mib >= 1024 ? `${(mib / 1024).toFixed(1)}G` : `${Math.round(mib)}M`);

export default function EksPage() {
  const [activeAccount] = useActiveAccount();
  const [rows, setRows] = useState<Cluster[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [guide, setGuide] = useState<{ cluster: string; data: Guide } | null>(null);
  const [busyCluster, setBusyCluster] = useState('');
  const [fleet, setFleet] = useState<FleetCluster[]>([]);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/eks?${accountParam(activeAccount) || 'account=self'}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setRows(d.clusters); setAdmin(!!d.admin); })
      .catch((e) => setErr(String(e)));
  }, [activeAccount]);
  // Monotonic fleet sequence — register/unregister re-fetches must not be
  // overwritten by an older in-flight response (P4 gate: codex). Failures keep
  // the previous fleet (best-effort live data beats a blank page).
  const fleetSeqRef = useRef(0);
  const loadFleet = useCallback(() => { // fleet-wide live aggregates (v1 K8s-Overview parity) — best-effort
    const seq = ++fleetSeqRef.current;
    fetch('/api/eks/fleet')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && seq === fleetSeqRef.current) setFleet(d.clusters ?? []); })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadFleet(); }, [loadFleet]);

  // Manual refresh: re-fetch both the access list and the live fleet; stamp
  // capturedAt once the fleet load settles (best-effort — never throws).
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await Promise.allSettled([
        fetch(`/api/eks?${accountParam(activeAccount) || 'account=self'}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((d) => { setRows(d.clusters); setAdmin(!!d.admin); setErr(''); })
          .catch((e) => setErr(String(e))),
        (async () => {
          const seq = ++fleetSeqRef.current;
          try {
            const r = await fetch('/api/eks/fleet');
            const d = r.ok ? await r.json() : null;
            if (d && seq === fleetSeqRef.current) setFleet(d.clusters ?? []);
          } catch { /* keep previous fleet */ }
        })(),
      ]);
      setCapturedAt(new Date().toISOString());
    } finally {
      setBusy(false);
    }
  }, []);

  async function register(cluster: string) {
    setBusyCluster(cluster); setNotice(''); setGuide(null);
    try {
      const res = await fetch(`/api/eks/${encodeURIComponent(cluster)}/register`, { method: 'POST' });
      if (res.status === 200) { setNotice(`${cluster} 등록 완료 — 바로 조회할 수 있습니다.`); load(); loadFleet(); }
      else if (res.status === 409) { const d = await res.json(); setGuide({ cluster, data: d.guide }); }
      else if (res.status === 403) setNotice('관리자 전용 기능입니다.');
      else if (res.status === 503) setNotice('등록 저장소(Aurora)가 설정되지 않았습니다.');
      else setNotice(`등록 실패 (${res.status})`);
    } catch { setNotice('등록 요청 실패'); }
    setBusyCluster('');
  }

  async function unregister(cluster: string) {
    setBusyCluster(cluster); setNotice('');
    try {
      const res = await fetch(`/api/eks/${encodeURIComponent(cluster)}/register`, { method: 'DELETE' });
      setNotice(res.ok ? `${cluster} 등록 해제됨.` : `해제 실패 (${res.status})`);
      load(); loadFleet();
    } catch { setNotice('해제 요청 실패'); }
    setBusyCluster('');
  }

  const btn = 'rounded-md border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 hover:bg-ink-100 disabled:opacity-50';

  // fleet entry by cluster name (only allowed/reachable-or-failed clusters appear).
  const fleetBy = useMemo(() => {
    const m = new Map<string, FleetCluster>();
    for (const f of fleet) m.set(f.name, f);
    return m;
  }, [fleet]);

  const reachable = useMemo(() => fleet.filter((f) => f.reachable), [fleet]);
  const connected = reachable.length;

  // Stats row totals (sum across the reachable fleet). Clusters count comes from
  // the access list (rows), not the fleet (fleet only holds allowed clusters).
  const totals = useMemo(() => reachable.reduce(
    (acc, f) => {
      acc.nodes += f.counts.nodes; acc.nodesReady += f.counts.nodesReady;
      acc.pods += f.counts.pods; acc.podsRunning += f.counts.podsRunning;
      acc.deployments += f.counts.deployments; acc.services += f.counts.services;
      return acc;
    },
    { nodes: 0, nodesReady: 0, pods: 0, podsRunning: 0, deployments: 0, services: 0 },
  ), [reachable]);

  // Pod status merged across the fleet → [{name,value}] for the donut.
  const podStatusData = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of reachable) {
      for (const [k, v] of Object.entries(f.podStatus)) m.set(k, (m.get(k) ?? 0) + v);
    }
    return [...m.entries()].map(([name, value]) => ({ name, value }));
  }, [reachable]);

  // Pods per namespace merged across clusters, summed, sorted desc, top 10.
  const nsData = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of reachable) {
      for (const ns of f.podsByNamespace) m.set(ns.namespace, (m.get(ns.namespace) ?? 0) + ns.count);
    }
    return [...m.entries()]
      .map(([namespace, count]) => ({ namespace, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [reachable]);

  // Instance-type distribution merged across the reachable fleet → [{name,value}]
  // for the donut, sorted by count desc.
  const instanceTypeData = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of reachable) {
      for (const it of f.instanceTypes ?? []) m.set(it.type, (m.get(it.type) ?? 0) + it.count);
    }
    return [...m.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [reachable]);

  // Warning events merged across the fleet, newest first, with a cluster column.
  const eventRows = useMemo(() => reachable
    .flatMap((f) => f.events.map((e) => ({ cluster: f.name, ...e })))
    .sort((a, b) => b.lastSeenTs - a.lastSeenTs), [reachable]);

  const totalPods = totals.pods;

  return (
    <div>
      <PageHeader
        title="EKS Clusters"
        subtitle="Access Entry가 있는 클러스터는 바로 조회 등록할 수 있습니다 (v1의 kubeconfig 등록 대체)."
        right={<RefreshButton busy={busy} onClick={refresh} capturedAt={capturedAt} />}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <StatCard label="Clusters" value={(rows ?? []).length} icon={<Container size={16} />} />
        <StatCard label="Connected" value={connected} icon={<CheckCircle2 size={16} />} />
        <StatCard label="Nodes" value={totals.nodes} trend={`${totals.nodesReady} ready`} icon={<Server size={16} />} />
        <StatCard label="Pods" value={totals.pods} trend={`${totals.podsRunning} running`} icon={<Boxes size={16} />} />
        <StatCard label="Deployments" value={totals.deployments} icon={<Layers size={16} />} />
        <StatCard label="Services" value={totals.services} icon={<Network size={16} />} />
      </div>

      {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
      {notice && <div className="text-[13px] text-brand-700">{notice}</div>}
      {!rows && !err && <div className="text-ink-400">로딩 중…</div>}

      {guide && (
        <div className="rounded-lg border border-ink-200 bg-paper-muted p-4 flex flex-col gap-3">
          <div className="text-[13px] font-semibold text-ink-800">🔧 {guide.cluster} 온보딩 가이드</div>
          {guide.data.commands.map((cmd) => (
            <div key={cmd} className="flex items-start gap-2">
              <code className="flex-1 rounded bg-ink-800 text-paper text-[11px] p-2 overflow-x-auto whitespace-pre">{cmd}</code>
              <button
                className={copied === cmd ? `${btn} !text-emerald-600 !border-emerald-300` : btn}
                onClick={() => {
                  void navigator.clipboard.writeText(cmd).then(() => {
                    setCopied(cmd);
                    setTimeout(() => setCopied((c) => (c === cmd ? '' : c)), 1500);
                  });
                }}
              >
                {copied === cmd ? 'Copied!' : '복사'}
              </button>
            </div>
          ))}
          <div className="text-[12px] text-ink-500">{guide.data.note}</div>
          <button className={`${btn} self-start`} onClick={() => setGuide(null)}>닫기</button>
        </div>
      )}

      {rows && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((c) => {
            const f = fleetBy.get(c.name);
            return (
              <Card key={c.name} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  {c.access === 'connected' ? (
                    <Link href={`/eks/${encodeURIComponent(c.name)}`} className="font-mono text-[13px] font-semibold text-brand-600 hover:underline">{c.name}</Link>
                  ) : (
                    <span className="font-mono text-[13px] font-semibold text-ink-700">{c.name}</span>
                  )}
                  {c.access === 'connected' && <Badge tone="positive" dot>Connected</Badge>}
                  {c.access === 'entry-only' && <Badge tone="brand" dot>Entry 있음</Badge>}
                  {c.access === 'no-entry' && <Badge tone="neutral">미연결</Badge>}
                  {c.access === 'unknown' && <Badge tone="neutral">확인 불가</Badge>}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                  <div><span className="text-ink-400">Status</span> <span className={c.status === 'ACTIVE' ? 'text-emerald-700' : 'text-ink-700'}>{c.status || '—'}</span></div>
                  <div><span className="text-ink-400">Version</span> <span className="text-ink-700">{c.version}</span></div>
                  <div><span className="text-ink-400">Region</span> <span className="text-ink-700">{c.region}</span></div>
                  <div><span className="text-ink-400">VPC</span> <span className="text-ink-700">{c.vpcId || '—'}</span></div>
                  <div><span className="text-ink-400">Platform</span> <span className="text-ink-700">{c.platformVersion || '—'}</span></div>
                </div>

                {f && f.reachable && (
                  <div className="mt-2 text-[12px] text-ink-500">
                    {f.counts.nodes} nodes · {f.counts.pods} pods · {f.counts.deployments} deploys
                  </div>
                )}
                {c.access === 'connected' && f && !f.reachable && (
                  <div className="mt-2"><Badge tone="negative" variant="soft">조회 불가</Badge></div>
                )}

                {(
                  (admin && (c.access === 'entry-only' || c.access === 'unknown')) ||
                  (c.access !== 'connected' && c.guide) ||
                  (admin && c.runtime)
                ) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {admin && (c.access === 'entry-only' || c.access === 'unknown') && (
                      <button className={btn} disabled={busyCluster === c.name} onClick={() => register(c.name)}>조회 등록</button>
                    )}
                    {c.access !== 'connected' && c.guide && (
                      <button className={btn} onClick={() => setGuide({ cluster: c.name, data: c.guide! })}>스크립트</button>
                    )}
                    {admin && c.runtime && (
                      <button className={btn} disabled={busyCluster === c.name} onClick={() => unregister(c.name)}>해제</button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {connected > 0 && reachable.some((f) => f.nodeAgg.length > 0) && (
        <Card title="노드 리소스" subtitle="Pod 요청 합계 대비 노드 allocatable (CPU 코어 · 메모리/디스크 G=GiB·M=MiB · request/allocatable 기준 — 디스크는 Pod가 ephemeral-storage request를 명시할 때만 채워짐)">
          <div className="flex flex-col gap-4">
            {reachable.filter((f) => f.nodeAgg.length > 0).map((f) => (
              <div key={f.name} className="flex flex-col gap-2">
                <div className="font-mono text-[12px] text-ink-500">{f.name}</div>
                {f.nodeAgg.map((n) => (
                  <div key={n.name} className="grid grid-cols-1 gap-y-1 sm:grid-cols-[minmax(0,14rem)_repeat(3,minmax(0,1fr))] sm:items-center sm:gap-x-4 text-[12px]">
                    <span className="min-w-0 truncate font-mono text-ink-700" title={n.name}>
                      {n.name}
                      {n.instanceType && <span className="ml-2 text-ink-400">{n.instanceType}</span>}
                      <span className="ml-2 text-ink-400">{n.podCount} pods</span>
                    </span>
                    <span className="flex items-center gap-2 text-ink-500">
                      <span className="w-8 shrink-0">CPU</span>
                      <Meter value={n.cpuPct} />
                      <span className="tabular text-ink-400">{n.cpuRequest.toFixed(1)}/{n.cpuAllocatable.toFixed(1)}</span>
                    </span>
                    <span className="flex items-center gap-2 text-ink-500">
                      <span className="w-8 shrink-0">Mem</span>
                      <Meter value={n.memPct} />
                      <span className="tabular text-ink-400">{fmtMib(n.memRequest)}/{fmtMib(n.memAllocatable)}</span>
                    </span>
                    <span className="flex items-center gap-2 text-ink-500">
                      <span className="w-8 shrink-0">Disk</span>
                      <Meter value={n.diskPct} />
                      <span className="tabular text-ink-400">{fmtMib(n.diskRequest)}/{fmtMib(n.diskAllocatable)}</span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Card>
      )}

      {connected > 0 && totalPods > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <DonutBreakdown title="Pod Status" data={podStatusData} nameKey="name" valueKey="value" />
          <DonutBreakdown title="Instance Types" data={instanceTypeData} nameKey="name" valueKey="value" />
          <BarDistribution title="Pods per Namespace" data={nsData} xKey="namespace" yKey="count" />
        </div>
      )}

      {connected > 0 && (
        eventRows.length > 0 ? (
          <Card title="Warning Events" subtitle="최근 클러스터 경고 (Warning type)" padded={false}>
            <DataTable
              columns={[
                { key: 'cluster', label: 'Cluster' }, { key: 'kind', label: 'Kind' },
                { key: 'object', label: 'Object' }, { key: 'reason', label: 'Reason' },
                { key: 'message', label: 'Message' }, { key: 'count', label: 'Count' },
                { key: 'lastSeen', label: 'Last Seen' },
              ]}
              rows={eventRows}
            />
          </Card>
        ) : (
          <div className="text-[12px] text-ink-400">경고 이벤트 없음</div>
        )
      )}
      </div>
    </div>
  );
}
