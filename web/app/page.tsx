'use client';
import { useEffect, useState } from 'react';
import StatCard from '@/components/ui/StatCard';

interface Overview { jobs: { queued: number; running: number; succeeded: number; failed: number }; clusterCount: number | null; mtdCost: number | null }

export default function Home() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/overview').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(setD).catch((e) => setErr(String(e)));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>Overview</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err} (세션 만료면 새로고침)</div>}
      {!d && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {d && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatCard label="Jobs 성공" value={d.jobs.succeeded} accent="#00ff88" />
          <StatCard label="Jobs 실패" value={d.jobs.failed} accent="#ef4444" />
          <StatCard label="Jobs 대기/실행" value={d.jobs.queued + d.jobs.running} accent="#f59e0b" />
          <StatCard label="EKS 클러스터" value={d.clusterCount ?? '—'} accent="#00d4ff" />
          <StatCard label="이번 달 비용(USD)" value={d.mtdCost == null ? '—' : `$${d.mtdCost.toFixed(2)}`} accent="#a855f7" />
        </div>
      )}
    </main>
  );
}
