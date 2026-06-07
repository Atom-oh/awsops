'use client';
import { useEffect, useState, useCallback } from 'react';
import DataTable from '@/components/ui/DataTable';
import RefreshButton from '@/components/ui/RefreshButton';

export default function Ec2Page() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/inventory/ec2');
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setRows((d.rows as Record<string, unknown>[]).map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data as object) })));
      setCaptured(d.run?.finished_at ?? null);
    } catch (e) { setErr(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/inventory/ec2/refresh', { method: 'POST' });
      if (!r.ok) throw new Error(r.status === 401 ? '세션 만료 — 새로고침' : `수집 실패 (${r.status})`);
      await load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>EC2 Instances</h1>
      <RefreshButton busy={busy} onClick={refresh} capturedAt={captured} />
      {err && <div style={{ color: '#ef4444', marginBottom: 8 }}>{err}</div>}
      {!rows && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {rows && <DataTable columns={[{ key: 'resource_id', label: 'Instance' }, { key: 'instance_type', label: 'Type' }, { key: 'instance_state', label: 'State' }, { key: 'region', label: 'Region' }, { key: 'private_ip_address', label: 'Private IP' }, { key: 'vpc_id', label: 'VPC' }]} rows={rows} />}
    </main>
  );
}
