'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Background, Controls, MiniMap, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import DetailPanel from '@/components/ui/DetailPanel';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { buildFlowGraph, filterFromEntry, type FlowInput, type FlowKind, type FlowNode } from '@/lib/flow-topology';
import { layoutFlow } from '@/lib/flow-layout';
import { useTheme } from '@/lib/use-theme';

// ReactFlow touches the DOM on mount — load it client-only to avoid SSR mismatch.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

const TYPES = ['route53', 'cloudfront', 'alb', 'nlb', 'target_group', 'waf', 'ec2', 'lambda'] as const;
type InvType = (typeof TYPES)[number];
type Row = Record<string, unknown>;

// InvType → FlowInput key (target_group maps to `tg`). ec2/lambda enrich target labels only.
const FLOW_KEY: Record<InvType, keyof FlowInput> = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg', waf: 'waf',
  ec2: 'ec2', lambda: 'lambda',
};

// Node fill/border per FlowKind. Light + dark variants (ReactFlow dark colorMode flips default
// node text to light, so dark nodes get explicit dark fills + light text). Target nodes are
// colored by health instead (see HEALTH).
const KIND_LIGHT: Record<FlowKind, [string, string]> = {
  route53: ['#E6F6EC', '#2E9E5B'], cloudfront: ['#E6EEFE', '#3D6FB5'], alb: ['#FEF3E2', '#C8902F'], nlb: ['#FEF3E2', '#C8902F'],
  tg: ['#F1E9FF', '#8A5BD0'], waf: ['#FDECE8', '#C85A45'], target: ['#EBEFF2', '#AFBAC3'],
  origin: ['#EBEFF2', '#AFBAC3'], more: ['#EBEFF2', '#AFBAC3'],
};
const KIND_DARK: Record<FlowKind, [string, string]> = {
  route53: ['#0E2E1C', '#2E9E5B'], cloudfront: ['#16243E', '#3D6FB5'], alb: ['#33260C', '#C8902F'], nlb: ['#33260C', '#C8902F'],
  tg: ['#241A3E', '#8A5BD0'], waf: ['#331410', '#C85A45'], target: ['#1F262D', '#586773'],
  origin: ['#1F262D', '#586773'], more: ['#1F262D', '#586773'],
};
const HEALTH_LIGHT: Record<string, [string, string]> = {
  healthy: ['#E6F6F2', '#01A88D'], unhealthy: ['#FDECE8', '#D13212'],
  draining: ['#FEF3E2', '#F59E0B'], initial: ['#FEF3E2', '#F59E0B'],
};
const HEALTH_DARK: Record<string, [string, string]> = {
  healthy: ['#0E2E2A', '#2CC9AE'], unhealthy: ['#3A1712', '#F26B4D'],
  draining: ['#33260C', '#F5B53C'], initial: ['#33260C', '#F5B53C'],
};

function nodeColors(n: FlowNode, dark: boolean): [string, string] {
  if (n.kind === 'target') {
    const h = String(n.meta?.health ?? 'unknown');
    const map = dark ? HEALTH_DARK : HEALTH_LIGHT;
    return map[h] ?? (dark ? KIND_DARK.target : KIND_LIGHT.target);
  }
  return (dark ? KIND_DARK : KIND_LIGHT)[n.kind];
}

const PREFIX: Record<FlowKind, string> = {
  route53: 'DNS', cloudfront: 'CF', alb: 'ALB', nlb: 'NLB', tg: 'TG', waf: 'WAF', target: '', origin: '', more: '',
};

function nodeLabel(n: FlowNode): string {
  if (n.kind === 'target') {
    const t = n.meta?.targetType ? `${n.meta.targetType} · ` : '';
    const h = n.meta?.health ? ` (${n.meta.health})` : '';
    return `${t}${n.label}${h}`;
  }
  const p = PREFIX[n.kind];
  return p ? `${p} · ${n.label}` : n.label;
}

const ROW_CAP = 500; // /api/inventory caps limit at 500

async function fetchType(t: InvType): Promise<{ rows: Row[]; finishedAt: string | null; capped: boolean }> {
  const r = await fetch(`/api/inventory/${t}?limit=${ROW_CAP}`);
  if (!r.ok) return { rows: [], finishedAt: null, capped: false };
  const d = await r.json();
  const rows = (d.rows ?? []) as { resource_id: unknown; region: unknown; data?: object }[];
  return {
    rows: rows.map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data ?? {}) })),
    finishedAt: d.run?.finished_at ?? null,
    capped: rows.length >= ROW_CAP, // hit the cap → more rows exist, surfaced below (no silent truncation)
  };
}

export default function TopologyPage() {
  const [data, setData] = useState<FlowInput | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [cappedTypes, setCappedTypes] = useState<string[]>([]);
  const [entryId, setEntryId] = useState<string>('');
  const [selected, setSelected] = useState<FlowNode | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await Promise.all(TYPES.map(fetchType));
      const out: FlowInput = {};
      let newest: string | null = null;
      const capped: string[] = [];
      TYPES.forEach((t, i) => {
        out[FLOW_KEY[t]] = res[i].rows;
        const f = res[i].finishedAt;
        if (f && (!newest || f > newest)) newest = f;
        if (res[i].capped) capped.push(t);
      });
      setData(out);
      setSyncedAt(newest);
      setCappedTypes(capped);
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dark = useTheme() === 'dark';

  const full = useMemo(() => (data ? buildFlowGraph(data) : { nodes: [], edges: [] }), [data]);

  // Entry-point options (CloudFront distributions, then load balancers).
  const entryOptions = useMemo(() => ({
    cf: full.nodes.filter((n) => n.kind === 'cloudfront'),
    lb: full.nodes.filter((n) => n.kind === 'alb' || n.kind === 'nlb'),
  }), [full]);

  const { nodes, edges } = useMemo(() => {
    const g = filterFromEntry(full, entryId || null);
    const pos = Object.fromEntries(layoutFlow(g).map((p) => [p.id, p]));
    const nodes: Node[] = g.nodes.map((n) => {
      const [bg, border] = nodeColors(n, dark);
      const p = pos[n.id] ?? { x: 0, y: 0 };
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: nodeLabel(n), fnode: n },
        // LR layout → handles on left/right so edges flow horizontally (not top/bottom).
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: bg,
          border: `${n.kind === 'origin' ? '1px dashed' : '1px solid'} ${border}`,
          color: dark ? '#E3E9EE' : '#16202A',
          borderRadius: 8, fontSize: 11, padding: 6, width: 220,
        },
      };
    });
    const edges: Edge[] = g.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, animated: false,
      // confidence convention: observed = solid, inferred (Spec 2) = dashed.
      style: e.confidence === 'inferred' ? { strokeDasharray: '4 4' } : undefined,
    }));
    return { nodes, edges };
  }, [full, entryId, dark]);

  // Detail for the clicked node: resource nodes show their full inventory row (every field —
  // vpc, subnet, tags …); target/origin nodes synthesize a small detail from their meta.
  const detail = useMemo(() => {
    if (!selected) return null;
    const m = (selected.meta ?? {}) as Record<string, unknown>;
    if (m.row) {
      const row = m.row as Record<string, unknown>;
      return { title: String(row.resource_id ?? selected.label), data: row, spec: m.invType ? INVENTORY_TYPES[m.invType as string] : undefined };
    }
    const syn: Record<string, unknown> = { resource_id: String(m.id ?? selected.label), kind: selected.kind };
    if (selected.kind === 'target') { syn.target_type = m.targetType; syn.health = m.health; syn.port = m.port; if (m.resolved) syn.resolved_as = m.resolved; }
    return { title: selected.label, data: syn, spec: undefined };
  }, [selected]);

  const onEntry = (e: React.ChangeEvent<HTMLSelectElement>) => setEntryId(e.target.value);
  const selectCls = 'rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-700';

  return (
    <>
      <PageHeader
        title="Topology"
        subtitle="요청 흐름 그래프 (Route53 → CloudFront → LB → Target Group → 타깃)"
        right={
          <div className="flex items-center gap-2">
            <select className={selectCls} value={entryOptions.cf.some((n) => n.id === entryId) ? entryId : ''} onChange={onEntry}>
              <option value="">CloudFront: 전체</option>
              {entryOptions.cf.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
            <select className={selectCls} value={entryOptions.lb.some((n) => n.id === entryId) ? entryId : ''} onChange={onEntry}>
              <option value="">LB: 전체</option>
              {entryOptions.lb.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
            <RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />
          </div>
        }
      />
      <div className="px-8 py-8 flex flex-col gap-4">
        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
        {!data && !err && <div className="text-ink-400">로딩 중…</div>}
        {data && !err && (
          full.nodes.length === 0 ? (
            <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
              그래프로 그릴 리소스가 없습니다. (cloudfront/alb/nlb/target_group sync 확인 — target_group은
              steampipe 동기화 후 채워집니다.)
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 text-[12px] text-ink-400">
                <span>노드 {nodes.length} · 엣지 {edges.length}</span>
                {syncedAt && <span>인벤토리 동기화: {new Date(syncedAt).toLocaleString()}</span>}
                {cappedTypes.length > 0 && (
                  <span className="text-warning">⚠ {cappedTypes.join(', ')} {ROW_CAP}개 초과 — 일부만 표시</span>
                )}
              </div>
              <div className="h-[640px] w-full rounded-lg border border-ink-100 bg-card">
                <ReactFlow nodes={nodes} edges={edges} fitView colorMode={dark ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}
                  onNodeClick={(_, node) => setSelected(((node.data as { fnode?: FlowNode })?.fnode) ?? null)}>
                  <Background />
                  <Controls />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              </div>
            </>
          )
        )}
      </div>
      {detail && (
        <DetailPanel title={detail.title} data={detail.data} spec={detail.spec} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
