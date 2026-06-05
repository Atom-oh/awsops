'use client';
import { useEffect, useState } from 'react';
import DataTable from '@/components/ui/DataTable';

export default function JobsPage() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/jobs').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d) => setRows(d.jobs)).catch((e) => setErr(String(e)));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>Async Jobs</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err}</div>}
      {!rows && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {rows && <DataTable columns={[{ key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'runtime', label: 'Runtime' }, { key: 'error', label: 'Error' }, { key: 'created_at', label: 'Created' }]} rows={rows} />}
    </main>
  );
}
