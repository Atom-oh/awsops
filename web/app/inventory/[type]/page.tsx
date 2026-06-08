'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import DataTable from '@/components/ui/DataTable';
import RefreshButton from '@/components/ui/RefreshButton';
import { INVENTORY_TYPES } from '@/lib/inventory-types';

export default function InventoryTypePage() {
  const params = useParams();
  const type = String(params.type);
  const spec = INVENTORY_TYPES[type];

  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/inventory/${type}`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setRows((d.rows as Record<string, unknown>[]).map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data as object) })));
      setCaptured(d.run?.finished_at ?? null);
    } catch (e) { setErr(String(e)); }
  }, [type]);
  useEffect(() => { if (spec) load(); }, [spec, load]);

  const refresh = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/inventory/${type}/refresh`, { method: 'POST' });
      if (!r.ok) throw new Error(r.status === 401 ? '세션 만료 — 새로고침' : `수집 실패 (${r.status})`);
      await load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  if (!spec) {
    return (
      <main style={{ padding: 24 }}>
        <div style={{ color: '#ef4444' }}>Unknown inventory type: {type}</div>
      </main>
    );
  }

  const columns = [{ key: 'resource_id', label: 'ID' }, { key: 'region', label: 'Region' }, ...spec.columns];

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>{spec.label}</h1>
      <RefreshButton busy={busy} onClick={refresh} capturedAt={captured} />
      {err && <div style={{ color: '#ef4444', marginBottom: 8 }}>{err}</div>}
      {!rows && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {rows && <DataTable columns={columns} rows={rows} />}
    </main>
  );
}
