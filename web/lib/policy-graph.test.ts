import { describe, it, expect } from 'vitest';
import { boundGraph, policyNodeId, policyEdgeId, type PolicyGraphNode, type PolicyGraphEdge } from './policy-graph';

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/** nodeCount nodes (ids node-000..node-{nodeCount-1}); edgeCount edges chained/wrapped only among
 * the FIRST `edgeUniverse` nodes so truncating to fewer nodes never orphans an edge in these tests. */
function makeGraph(nodeCount: number, edgeCount: number, edgeUniverse = nodeCount): {
  version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[];
} {
  const nodes: PolicyGraphNode[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: policyNodeId('node', pad(i)),
    kind: 'node',
    label: `node ${i}`,
    status: 'allowed',
  }));
  const edges: PolicyGraphEdge[] = Array.from({ length: edgeCount }, (_, i) => {
    const source = policyNodeId('node', pad(i % edgeUniverse));
    const target = policyNodeId('node', pad((i + 1) % edgeUniverse));
    return { id: policyEdgeId(source, target, String(i)), source, target, relation: 'related', status: 'allowed' as const };
  });
  return { version: 1, capturedAt: '2026-08-19T00:00:00Z', nodes, edges };
}

describe('boundGraph', () => {
  it('passes an under-cap graph through unchanged', () => {
    const graph = makeGraph(3, 2);
    const bounded = boundGraph(graph, { nodes: 250, edges: 400 });
    expect(bounded.nodes).toHaveLength(3);
    expect(bounded.edges).toHaveLength(2);
    expect(bounded.truncated).toBe(false);
    expect(bounded.omitted).toEqual({ nodes: 0, edges: 0 });
  });

  it('caps persisted graphs and records omitted counts', () => {
    // 410 edges all reference only the first 250 nodes, so the node cap never orphans an edge —
    // the edge count below is driven purely by the edge cap, isolating the two limits.
    const graph = makeGraph(260, 410, 250);
    const bounded = boundGraph(graph, { nodes: 250, edges: 400 });
    expect(bounded.nodes).toHaveLength(250);
    expect(bounded.edges).toHaveLength(400);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omitted).toEqual({ nodes: 10, edges: 10 });
  });

  it('drops and counts edges left dangling by the node cap, even under the edge cap', () => {
    // edgeUniverse === nodeCount here: every node index appears as a source/target, so cutting
    // node-005..node-009 orphans every edge touching them.
    const graph = makeGraph(10, 10);
    const bounded = boundGraph(graph, { nodes: 5, edges: 400 });
    expect(bounded.nodes).toHaveLength(5);
    for (const e of bounded.edges) {
      expect(bounded.nodes.some((n) => n.id === e.source)).toBe(true);
      expect(bounded.nodes.some((n) => n.id === e.target)).toBe(true);
    }
    expect(bounded.omitted.nodes).toBe(5);
    expect(bounded.omitted.edges).toBeGreaterThan(0);
    expect(bounded.truncated).toBe(true);
  });

  it('sorts nodes and edges by id before truncating, deterministically across calls', () => {
    const graph = makeGraph(5, 5);
    const shuffled = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    const a = boundGraph(graph, { nodes: 3, edges: 2 });
    const b = boundGraph(shuffled, { nodes: 3, edges: 2 });
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.edges.map((e) => e.id)).toEqual(b.edges.map((e) => e.id));
  });

  it('preserves capturedAt', () => {
    const graph = makeGraph(1, 0);
    const bounded = boundGraph(graph, { nodes: 250, edges: 400 });
    expect(bounded.capturedAt).toBe('2026-08-19T00:00:00Z');
  });
});

describe('policyNodeId / policyEdgeId', () => {
  it('derives stable ids from kind/resourceId', () => {
    expect(policyNodeId('eni', 'eni-123')).toBe('eni:eni-123');
  });

  it('derives an edge id from source/target, optionally suffixed', () => {
    expect(policyEdgeId('eni:eni-123', 'sg:sg-123')).toBe('eni:eni-123->sg:sg-123');
    expect(policyEdgeId('eni:eni-123', 'sg:sg-123', '0')).toBe('eni:eni-123->sg:sg-123#0');
  });
});
