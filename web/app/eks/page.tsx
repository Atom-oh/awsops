'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import DataTable from '@/components/ui/DataTable';
import Badge from '@/components/ui/Badge';
import StatCard from '@/components/ui/StatCard';

// EKS cluster list — v1-parity columns + access badge + runtime registration
// (the v2 equivalent of v1's "Register kubeconfig": Access-Entry holders register
// instantly; others get the v1-style CLI onboarding guide).

interface Cluster {
  name: string; status?: string; version?: string; region?: string;
  vpcId?: string; platformVersion?: string;
  access: 'connected' | 'entry-only' | 'no-entry' | 'unknown';
  runtime?: boolean;
  guide?: Guide;
}
interface Summary { clusters: number; reachable: number; nodes: number; pods: number; deployments: number; services: number }
interface Guide { commands: string[]; note: string }

export default function EksPage() {
  const [rows, setRows] = useState<Cluster[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [guide, setGuide] = useState<{ cluster: string; data: Guide } | null>(null);
  const [busyCluster, setBusyCluster] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [copied, setCopied] = useState('');

  const load = useCallback(() => {
    fetch('/api/eks')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setRows(d.clusters); setAdmin(!!d.admin); })
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { // fleet-wide live counts (v1 K8s-Overview parity) — best-effort
    fetch('/api/eks/summary').then((r) => (r.ok ? r.json() : null)).then(setSummary).catch(() => {});
  }, []);

  async function register(cluster: string) {
    setBusyCluster(cluster); setNotice(''); setGuide(null);
    try {
      const res = await fetch(`/api/eks/${encodeURIComponent(cluster)}/register`, { method: 'POST' });
      if (res.status === 200) { setNotice(`${cluster} 등록 완료 — 바로 조회할 수 있습니다.`); load(); }
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
      load();
    } catch { setNotice('해제 요청 실패'); }
    setBusyCluster('');
  }

  const btn = 'rounded-md border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 hover:bg-ink-100 disabled:opacity-50';

  const tableRows = (rows ?? []).map((c) => ({
    name: c.access === 'connected'
      ? <Link href={`/eks/${encodeURIComponent(c.name)}`} className="text-claude-600 hover:underline">{c.name}</Link>
      : <span className="text-ink-600">{c.name}</span>,
    status: c.status, version: c.version, region: c.region,
    vpc: c.vpcId || '—', platform: c.platformVersion || '—',
    access: (
      <span className="flex items-center gap-2">
        {c.access === 'connected' && <Badge tone="positive" dot>Connected</Badge>}
        {c.access === 'entry-only' && <Badge tone="brand" dot>Entry 있음</Badge>}
        {c.access === 'no-entry' && <Badge tone="neutral">미연결</Badge>}
        {c.access === 'unknown' && <Badge tone="neutral">확인 불가</Badge>}
        {admin && (c.access === 'entry-only' || c.access === 'unknown') && (
          <button className={btn} disabled={busyCluster === c.name} onClick={() => register(c.name)}>조회 등록</button>
        )}
        {c.access !== 'connected' && c.guide && (
          <button className={btn} onClick={() => setGuide({ cluster: c.name, data: c.guide! })}>스크립트</button>
        )}
        {admin && c.runtime && (
          <button className={btn} disabled={busyCluster === c.name} onClick={() => unregister(c.name)}>해제</button>
        )}
      </span>
    ),
  }));

  return (
    <div className="px-8 py-8 flex flex-col gap-6">
      <div>
        <h1 className="text-[15px] font-semibold text-ink-800">EKS Clusters</h1>
        <p className="text-[12px] text-ink-400">Access Entry가 있는 클러스터는 바로 조회 등록할 수 있습니다 (v1의 kubeconfig 등록 대체).</p>
      </div>
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <StatCard label="Clusters" value={summary.clusters === 0 ? (rows?.length ?? 0) : summary.clusters} />
          <StatCard label="Connected" value={summary.reachable} />
          <StatCard label="Nodes" value={summary.nodes} />
          <StatCard label="Pods" value={summary.pods} />
          <StatCard label="Deployments" value={summary.deployments} />
          <StatCard label="Services" value={summary.services} />
        </div>
      )}
      {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
      {notice && <div className="text-[13px] text-claude-700">{notice}</div>}
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
        <DataTable
          columns={[
            { key: 'name', label: 'Name' }, { key: 'status', label: 'Status' },
            { key: 'version', label: 'Version' }, { key: 'region', label: 'Region' },
            { key: 'vpc', label: 'VPC' }, { key: 'platform', label: 'Platform' },
            { key: 'access', label: '연결' },
          ]}
          rows={tableRows}
        />
      )}
    </div>
  );
}
