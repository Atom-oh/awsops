'use client';
import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';
import SegmentedControl from '@/components/ui/SegmentedControl';

// Minimal local shape for the /api/eks response — intentionally NOT importing aws.ts ClusterInfo
// (the page only needs .name; decoupled from the shared type per consensus Decision 2).
interface EksClusterRow { name: string; [k: string]: unknown }
interface InstallStatus { installed: boolean; ready: boolean; reason?: string }
interface SavedConfig { chartVersion: string | null; config: { values?: Record<string, unknown>; override?: Record<string, unknown> } | null }

const btn = 'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors';

export default function OpencostPage() {
  const [clusters, setClusters] = useState<string[]>([]);
  const [cluster, setCluster] = useState<string>('');
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [chartVersion, setChartVersion] = useState('');
  const [overrideText, setOverrideText] = useState('');
  const [msg, setMsg] = useState('');
  const [bundle, setBundle] = useState<{ valuesYaml: string; installSh: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/eks');
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      const names = (d.clusters as EksClusterRow[]).map((c) => c.name);
      setClusters(names);
      if (names.length) setCluster((c) => c || names[0]); // refresh keeps the user's selection (P4: kiro)
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadCluster = useCallback(async (name: string) => {
    setStatus(null); setBundle(null); setMsg('');
    // status (404 = not onboarded for in-app queries)
    const sr = await fetch(`/api/opencost/${encodeURIComponent(name)}/status`);
    if (sr.status === 404) { setStatus(null); setMsg('이 클러스터는 인-앱 조회로 온보딩되지 않았습니다 (Access Entry 필요).'); return; }
    if (sr.ok) setStatus(await sr.json());
    // config
    const cr = await fetch(`/api/opencost/${encodeURIComponent(name)}`);
    if (cr.ok) {
      const { config } = (await cr.json()) as { config: SavedConfig['config'] & { chartVersion?: string } | null };
      const saved = config as unknown as SavedConfig | null;
      setChartVersion(saved && 'chartVersion' in (saved as object) ? (saved as SavedConfig).chartVersion ?? '' : '');
      setOverrideText(saved?.config?.override ? JSON.stringify(saved.config.override, null, 2) : '');
    }
  }, []);

  useEffect(() => { if (cluster) loadCluster(cluster); }, [cluster, loadCluster]);

  async function save() {
    setMsg('');
    let override: Record<string, unknown> | undefined;
    if (overrideText.trim()) {
      try { override = JSON.parse(overrideText); } catch { setMsg('override JSON 파싱 실패'); return; }
    }
    const res = await fetch(`/api/opencost/${encodeURIComponent(cluster)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chartVersion: chartVersion || null, config: { values: {}, override } }),
    });
    if (res.status === 403) setMsg('관리자 전용');
    else if (res.status === 503) setMsg('저장소 미설정');
    else if (res.ok) setMsg('저장됨');
    else setMsg(`저장 실패 (${res.status})`);
  }

  async function download() {
    const res = await fetch(`/api/opencost/${encodeURIComponent(cluster)}/bundle`);
    if (!res.ok) { setMsg(`번들 생성 실패 (${res.status})`); return; }
    const b = (await res.json()) as { valuesYaml: string; installSh: string };
    setBundle(b);
    for (const [name, body] of [['values.yaml', b.valuesYaml], ['install.sh', b.installSh]] as const) {
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    }
  }

  return (
    <>
      <PageHeader
        title="OpenCost"
        subtitle="EKS 비용 — 설치 번들 생성(다운로드) · 설치상태 조회 (read-only, 설치는 직접 실행)"
        right={
          <>
            <Badge tone="brand" variant="soft" dot>read-only</Badge>
            <RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />
          </>
        }
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">클러스터 로드 실패: {err}</div>}

        {clusters.length > 0 && (
          <div className="overflow-x-auto"><SegmentedControl options={clusters} value={cluster} onChange={setCluster} /></div>
        )}

        <Card title="설치 상태" subtitle="presigned-STS 읽기 전용 조회">
          {status === null ? (
            <div className="text-[13px] text-ink-400">{msg || '조회 중…'}</div>
          ) : status.installed ? (
            <Badge tone={status.ready ? 'positive' : 'brand'} variant="soft" dot>{status.ready ? '설치됨 · Ready' : '설치됨 · Not Ready'}</Badge>
          ) : (
            <Badge tone="neutral" variant="soft">미설치{status.reason ? ` (${status.reason})` : ''}</Badge>
          )}
        </Card>

        <Card title="Helm 설정" subtitle="chart version(비우면 latest) + 자유형 values override(JSON)">
          <div className="flex flex-col gap-3">
            <label className="text-[12px] text-ink-500">Chart version (선택 — 비우면 latest)
              <input value={chartVersion} onChange={(e) => setChartVersion(e.target.value)} placeholder="latest"
                className="mt-1 w-full rounded-md border border-ink-200 px-2 py-1 text-[13px] font-mono" />
            </label>
            <label className="text-[12px] text-ink-500">values override (JSON, 선택)
              <textarea value={overrideText} onChange={(e) => setOverrideText(e.target.value)} rows={5}
                placeholder='{ "opencost": { "ui": { "enabled": true } } }'
                className="mt-1 w-full rounded-md border border-ink-200 px-2 py-1 text-[12px] font-mono" />
            </label>
            <div className="flex items-center gap-3">
              <button type="button" onClick={save} className={`${btn} bg-brand-500 text-white hover:bg-brand-600`}>저장 (admin)</button>
              <button type="button" onClick={download} className={`${btn} border border-ink-200 text-ink-700 hover:bg-ink-50`}>설치 번들 다운로드</button>
              {msg && <span className="text-[12px] text-ink-500">{msg}</span>}
            </div>
          </div>
        </Card>

        {bundle && (
          <Card title="install.sh" subtitle="본인 kubeconfig로 직접 실행 (AWSops는 클러스터에 쓰지 않음)">
            <pre className="max-h-[260px] overflow-auto rounded bg-ink-50 p-3 text-[11px] leading-snug text-ink-700">{bundle.installSh}</pre>
          </Card>
        )}
      </div>
    </>
  );
}
