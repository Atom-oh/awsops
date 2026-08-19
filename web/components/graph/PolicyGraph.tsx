'use client';

import { useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Background, MiniMap, Position, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CheckCircle2, XCircle, CircleHelp, CircleDashed, CircleSlash, type LucideIcon } from 'lucide-react';
import { layoutFlow } from '@/lib/flow-layout';
import type { FlowGraph } from '@/lib/flow-topology';
import type { PolicyGraphDto, PolicyGraphNode, PolicyGraphEdge, PolicyGraphStatus } from '@/lib/policy-graph';

// ReactFlow touches the DOM on mount — client-only (same pattern as app/topology/infra/page.tsx).
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

export interface PolicyGraphSelection {
  kind: 'node' | 'edge';
  id: string;
}

interface StatusMeta {
  marker: string;
  label: string;
  icon: LucideIcon;
  bg: string;
  border: string;
  text: string;
  stroke: string;
  dash: boolean;
}

// Status is never color-only: each state carries a distinct O/X/?/marker glyph, label, and line
// style (solid vs dashed) in addition to color — see the design's "Graph contract and UI" rules.
const STATUS_META: Record<PolicyGraphStatus, StatusMeta> = {
  allowed: { marker: 'O', label: 'Allowed', icon: CheckCircle2, bg: '#e8f6ef', border: '#16845b', text: '#16845b', stroke: '#16845b', dash: false },
  blocked: { marker: 'X', label: 'Blocked', icon: XCircle, bg: '#fcedea', border: '#c33b28', text: '#c33b28', stroke: '#c33b28', dash: false },
  unknown: { marker: '?', label: 'Unknown', icon: CircleHelp, bg: '#fff4df', border: '#a96508', text: '#a96508', stroke: '#a96508', dash: true },
  not_run: { marker: '·', label: 'Not run', icon: CircleDashed, bg: '#f4f6f8', border: '#c7d0d8', text: '#677582', stroke: '#97a5b2', dash: true },
  not_applicable: { marker: '—', label: 'Not applicable', icon: CircleSlash, bg: '#f4f6f8', border: '#dfe4e8', text: '#94a0aa', stroke: '#c7d0d8', dash: true },
};

function nodeSummaryText(n: PolicyGraphNode): string {
  const meta = STATUS_META[n.status];
  return `${n.kind}: ${n.label} — ${meta.marker} ${meta.label}`;
}

function edgeSummaryText(e: PolicyGraphEdge): string {
  const meta = STATUS_META[e.status];
  const detail = e.label ? ` ${e.label}` : '';
  return `${e.relation}${detail} — ${meta.marker} ${meta.label}`;
}

const CTRL_BTN = 'flex h-7 w-7 items-center justify-center rounded-md border border-ink-200 bg-card text-ink-500 hover:bg-ink-50';

/**
 * Shared read-only policy graph canvas — renders a `PolicyGraphDto` (web/lib/policy-graph.ts) via
 * React Flow, reusing the existing dagre layout (`layoutFlow`) rather than a bespoke one. Used by
 * Network Path Check (full, with MiniMap) and the Security Group Usage/Rules detail graphs
 * (`compact`, no MiniMap). Layout is read-only: pan/zoom/fit only, no persisted manual edits.
 */
export default function PolicyGraph({
  graph,
  compact = false,
  onSelect,
}: {
  graph: PolicyGraphDto;
  compact?: boolean;
  onSelect?: (selection: PolicyGraphSelection | null) => void;
}) {
  const instanceRef = useRef<ReactFlowInstance | null>(null);

  const { nodes, edges } = useMemo(() => {
    const flowGraph: FlowGraph = {
      nodes: graph.nodes.map((n) => ({ id: n.id, kind: 'more', label: n.label })),
      edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, confidence: 'observed' })),
    };
    const pos = Object.fromEntries(layoutFlow(flowGraph, { rankdir: 'LR' }).map((p) => [p.id, p]));

    const nodes: Node[] = graph.nodes.map((n) => {
      const meta = STATUS_META[n.status];
      const p = pos[n.id] ?? { x: 0, y: 0 };
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: `${meta.marker} ${n.label}` },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: meta.bg,
          border: `2px ${meta.dash ? 'dashed' : 'solid'} ${meta.border}`,
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 600,
          padding: 8,
          width: 172,
          color: '#17222d',
        },
      };
    });

    const edges: Edge[] = graph.edges.map((e) => {
      const meta = STATUS_META[e.status];
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label ? `${meta.marker} ${e.label}` : meta.marker,
        animated: false,
        style: { stroke: meta.stroke, strokeWidth: 2, strokeDasharray: meta.dash ? '7 5' : undefined },
        labelStyle: { fontSize: 10, fill: meta.text, fontWeight: 700 },
      };
    });

    return { nodes, edges };
  }, [graph]);

  return (
    <div className="relative h-full min-h-[320px] w-full" data-testid="policy-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onInit={(instance) => { instanceRef.current = instance; }}
        onNodeClick={(_evt, node) => onSelect?.({ kind: 'node', id: node.id })}
        onEdgeClick={(_evt, edge) => onSelect?.({ kind: 'edge', id: edge.id })}
        onPaneClick={() => onSelect?.(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        {!compact && <MiniMap pannable zoomable />}
      </ReactFlow>

      <div className="absolute bottom-2 left-2 z-10 grid gap-1">
        <button type="button" aria-label="Zoom in" onClick={() => instanceRef.current?.zoomIn()} className={CTRL_BTN}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => instanceRef.current?.zoomOut()} className={CTRL_BTN}>&minus;</button>
        <button type="button" aria-label="Fit graph" onClick={() => instanceRef.current?.fitView()} className={CTRL_BTN}>&#9633;</button>
      </div>

      {graph.truncated && (
        <div
          className={
            graph.pathTruncated
              ? 'absolute right-2 top-2 z-10 rounded-md border border-rose-400 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-800'
              : 'absolute right-2 top-2 z-10 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800'
          }
        >
          {graph.pathTruncated ? '⚠ ' : ''}
          {graph.omitted.nodes > 0 && `+${graph.omitted.nodes} nodes `}
          {graph.omitted.edges > 0 && `+${graph.omitted.edges} edges `}
          {graph.pathTruncated ? 'hidden — resolved path is incomplete, result may be wrong' : 'hidden by graph limits'}
        </div>
      )}

      {/* The checklist remains the accessible textual source of truth when the graph cannot
         render (design rule) — this list is always in the DOM, independent of canvas mount. */}
      <ul className="sr-only" aria-label="Policy graph summary">
        {graph.nodes.map((n) => <li key={n.id}>{nodeSummaryText(n)}</li>)}
        {graph.edges.map((e) => <li key={e.id}>{edgeSummaryText(e)}</li>)}
      </ul>
    </div>
  );
}
