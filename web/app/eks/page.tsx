'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import DataTable from '@/components/ui/DataTable';

interface Cluster { name: string; status?: string; version?: string; endpoint?: string }

export default function EksPage() {
  const [rows, setRows] = useState<Cluster[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/eks').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d) => setRows(d.clusters)).catch((e) => setErr(String(e)));
  }, []);
  // Link each cluster name to its in-cluster drill-in (DataTable renders element cells as-is).
  const tableRows = (rows ?? []).map((c) => ({
    ...c,
    name: (
      <Link href={`/eks/${encodeURIComponent(c.name)}`} className="text-claude-600 hover:underline">
        {c.name}
      </Link>
    ),
  }));
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>EKS Clusters</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err}</div>}
      {!rows && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {rows && <DataTable columns={[{ key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }, { key: 'version', label: 'Version' }, { key: 'endpoint', label: 'Endpoint' }]} rows={tableRows} />}
    </main>
  );
}
