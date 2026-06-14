'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import { buildTopology, type TopoKind } from '@/lib/topology';

// ReactFlow touches the DOM on mount — load it client-only to avoid SSR mismatch.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

const TYPES = ['vpc', 'subnet', 'ec2', 'rds', 'alb'] as const;
type InvType = (typeof TYPES)[number];
type Row = Record<string, unknown>;

// Column per kind (VPC → Subnet → workloads) + a tint per kind.
const COL: Record<TopoKind, number> = { vpc: 0, subnet: 1, ec2: 2, rds: 2, alb: 2 };
const TINT: Record<TopoKind, string> = {
  vpc: '#e0e7ff', subnet: '#dcfce7', ec2: '#fef3c7', rds: '#f3e8ff', alb: '#ffe4e6',
};

async function fetchType(t: InvType): Promise<Row[]> {
  // limit=500 (route caps at 500) so the graph isn't silently truncated at the 100-row default.
  const r = await fetch(`/api/inventory/${t}?limit=500`);
  if (!r.ok) return [];
  const d = await r.json();
  const rows = (d.rows ?? []) as { resource_id: unknown; region: unknown; data?: object }[];
  return rows.map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data ?? {}) }));
}

export default function TopologyPage() {
  const [data, setData] = useState<Record<InvType, Row[]> | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await Promise.all(TYPES.map(fetchType));
      const out = {} as Record<InvType, Row[]>;
      TYPES.forEach((t, i) => { out[t] = res[i]; });
      setData(out);
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const g = buildTopology(data);
    if (g.nodes.length >= 500) {
      // surface truncation rather than silently capping
      console.warn('[topology] hit the 500-row inventory cap — graph may be incomplete');
    }
    const yByCol: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
    const nodes: Node[] = g.nodes.map((n) => {
      const c = COL[n.kind];
      const y = yByCol[c]++;
      return {
        id: n.id,
        position: { x: c * 300, y: y * 64 },
        data: { label: `${n.kind.toUpperCase()} · ${n.label}` },
        style: { background: TINT[n.kind], border: '1px solid #c7c7c7', borderRadius: 8, fontSize: 11, padding: 6, width: 220 },
      };
    });
    const edges: Edge[] = g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: false }));
    return { nodes, edges };
  }, [data]);

  return (
    <>
      <PageHeader
        title="Topology"
        subtitle="인벤토리 기반 인프라 토폴로지 (VPC → Subnet → EC2/RDS/ALB)"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-8 py-8 flex flex-col gap-4">
        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
        {!data && !err && <div className="text-ink-400">로딩 중…</div>}
        {data && !err && (
          nodes.length === 0 ? (
            <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
              그래프로 그릴 인벤토리 리소스가 없습니다. (vpc/subnet/ec2/rds/alb sync 확인)
            </div>
          ) : (
            <div className="h-[640px] w-full rounded-lg border border-ink-100 bg-white">
              <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </div>
          )
        )}
      </div>
    </>
  );
}
