'use client';
import { useEffect, useState } from 'react';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import SectionLabel from '@/components/ui/SectionLabel';

interface Overview { jobs: { queued: number; running: number; succeeded: number; failed: number }; clusterCount: number | null; mtdCost: number | null }

export default function Home() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/overview').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(setD).catch((e) => setErr(String(e)));
  }, []);
  return (
    <>
      <PageHeader title="대시보드" live subtitle="실시간 AWS · Kubernetes 운영 현황" />
      <div className="px-8 py-8">
        {err && <div className="text-rose-500">로드 실패: {err} (세션 만료면 새로고침)</div>}
        {!d && !err && <div className="text-ink-400">로딩 중…</div>}
        {d && (
          <section className="flex flex-col gap-3">
            <SectionLabel>운영 요약</SectionLabel>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <StatTile label="Jobs 성공" value={d.jobs.succeeded} />
              <StatTile label="Jobs 실패" value={d.jobs.failed} variant="danger" />
              <StatTile label="Jobs 대기/실행" value={d.jobs.queued + d.jobs.running} variant="warn" />
              <StatTile label="EKS 클러스터" value={d.clusterCount ?? '—'} variant="accent" />
              <StatTile label="이번 달 비용(USD)" value={d.mtdCost == null ? '—' : `$${d.mtdCost.toFixed(2)}`} />
            </div>
          </section>
        )}
      </div>
    </>
  );
}
