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
    expect(bounded.pathTruncated).toBe(false);
    expect(bounded.omitted).toEqual({ nodes: 0, edges: 0 });
  });

  it('caps persisted graphs and records omitted counts (decorative-only, not path-truncated)', () => {
    // 410 edges all reference only the first 250 nodes, so the node cap never orphans an edge —
    // the edge count below is driven purely by the edge cap, isolating the two limits.
    const graph = makeGraph(260, 410, 250);
    const bounded = boundGraph(graph, { nodes: 250, edges: 400 });
    expect(bounded.nodes).toHaveLength(250);
    expect(bounded.edges).toHaveLength(400);
    expect(bounded.truncated).toBe(true);
    expect(bounded.pathTruncated).toBe(false);
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

  it('never drops a resolved-path node in favor of an unrelated node with an earlier id', () => {
    // path-01's own nodes/edges sort AFTER the decorative candidate nodes alphabetically —
    // a naive id-sort-then-slice would silently sever the resolved path while keeping unrelated
    // exploration nodes, which for a security decision graph is actively misleading, not just lossy.
    const pathNodes: PolicyGraphNode[] = [
      { id: 'zz-source', kind: 'eni', label: 'source', status: 'allowed', pathIds: ['path-01'] },
      { id: 'zz-target', kind: 'listener', label: 'destination', status: 'blocked', pathIds: ['path-01'] },
    ];
    const pathEdge: PolicyGraphEdge = {
      id: 'zz-source->zz-target', source: 'zz-source', target: 'zz-target', relation: 'routed-to', status: 'blocked', pathIds: ['path-01'],
    };
    const decorativeNodes: PolicyGraphNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `aa-candidate-${i}`, kind: 'candidate', label: `candidate ${i}`, status: 'not_applicable',
    }));
    const graph = {
      version: 1 as const,
      capturedAt: '2026-08-19T00:00:00Z',
      nodes: [...decorativeNodes, ...pathNodes],
      edges: [pathEdge],
    };

    const bounded = boundGraph(graph, { nodes: 3, edges: 1 });

    expect(bounded.nodes).toHaveLength(3);
    expect(bounded.nodes.some((n) => n.id === 'zz-source')).toBe(true);
    expect(bounded.nodes.some((n) => n.id === 'zz-target')).toBe(true);
    // the resolved-path edge must survive intact, not be orphaned by a naive alphabetical cut
    expect(bounded.edges.some((e) => e.id === 'zz-source->zz-target')).toBe(true);
  });

  it('enforces the hard cap even over path structure, but flags it distinctly via pathTruncated', () => {
    // A 4-hop resolved path (4 nodes, 3 edges) with caps far below that. The cap is a persistence/
    // rendering safety limit and must never be silently exceeded — so this MUST still cut down to
    // 2 nodes/1 edge. What must NOT happen is presenting that as ordinary decorative truncation:
    // pathTruncated must fire so a caller can react (e.g. fail the run) instead of quietly
    // rendering a possibly-wrong path.
    const ids = ['path-a', 'path-b', 'path-c', 'path-d'];
    const pathNodes: PolicyGraphNode[] = ids.map((id) => ({ id, kind: 'hop', label: id, status: 'allowed', pathIds: ['path-01'] }));
    const pathEdges: PolicyGraphEdge[] = [0, 1, 2].map((i) => ({
      id: `${ids[i]}->${ids[i + 1]}`, source: ids[i], target: ids[i + 1], relation: 'routed-to', status: 'allowed', pathIds: ['path-01'],
    }));
    const graph = { version: 1 as const, capturedAt: '2026-08-19T00:00:00Z', nodes: pathNodes, edges: pathEdges };

    const bounded = boundGraph(graph, { nodes: 2, edges: 1 });

    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.edges).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
    expect(bounded.pathTruncated).toBe(true);
    expect(bounded.omitted).toEqual({ nodes: 2, edges: 2 });
  });

  it('still drops decorative nodes in favor of the path when the path itself fits the cap', () => {
    const pathNodes: PolicyGraphNode[] = ['path-a', 'path-b', 'path-c'].map((id) => ({
      id, kind: 'hop', label: id, status: 'allowed', pathIds: ['path-01'],
    }));
    const decorativeNodes: PolicyGraphNode[] = ['aa-decor-0', 'aa-decor-1'].map((id) => ({
      id, kind: 'candidate', label: id, status: 'not_applicable',
    }));
    const graph = {
      version: 1 as const, capturedAt: '2026-08-19T00:00:00Z',
      nodes: [...decorativeNodes, ...pathNodes], edges: [],
    };

    const bounded = boundGraph(graph, { nodes: 3, edges: 400 });

    expect(bounded.nodes).toHaveLength(3);
    for (const n of pathNodes) expect(bounded.nodes.some((k) => k.id === n.id)).toBe(true);
    expect(bounded.omitted.nodes).toBe(2);
    expect(bounded.truncated).toBe(true);
    // the path itself fit within the cap — only decorative nodes were cut, so this is not a
    // path-integrity emergency and callers should not treat it as one.
    expect(bounded.pathTruncated).toBe(false);
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
