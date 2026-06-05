'use client';
import { useEffect, useState } from 'react';
import StatCard from '@/components/ui/StatCard';
import DataTable from '@/components/ui/DataTable';

interface Cost { total: number; currency: string; byService: { service: string; amount: number }[] }

export default function CostPage() {
  const [d, setD] = useState<Cost | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/cost').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(setD).catch((e) => setErr(String(e)));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>Cost (MTD)</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err} (Cost Explorer 권한/요금 확인)</div>}
      {!d && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {d && (
        <>
          <div style={{ marginBottom: 16 }}><StatCard label={`이번 달 합계 (${d.currency})`} value={`$${d.total.toFixed(2)}`} accent="#a855f7" /></div>
          <DataTable columns={[{ key: 'service', label: 'Service' }, { key: 'amount', label: 'Amount (USD)' }]} rows={d.byService.map((s) => ({ service: s.service, amount: s.amount.toFixed(2) }))} />
        </>
      )}
    </main>
  );
}
