// Shared PolicyGraph contract — the single graph DTO rendered by both Network Path Check and the
// Security Group Usage/Rules screens (docs/superpowers/specs/2026-08-13-network-path-check-design.md
// "Graph contract and UI"). Pure / React-independent so it can be unit-tested and reused by the
// worker (Python side keeps an equivalent shape; this is the TypeScript/BFF-and-UI side).
//
// `status` is a small, fixed visual vocabulary (icon + color + line style — never color alone).
// Domain evidence states (e.g. SG Rules' observed_compatible/overlapping/unassessable) map onto
// this vocabulary at the builder boundary; PolicyGraph itself stays domain-agnostic.
export type PolicyGraphStatus = 'allowed' | 'blocked' | 'unknown' | 'not_run' | 'not_applicable';

export interface PolicyGraphScope {
  accountId: string;
  region: string;
}

export interface PolicyGraphNode {
  id: string;
  kind: string;
  label: string;
  status: PolicyGraphStatus;
  resourceId?: string;
  scope?: PolicyGraphScope;
  pathIds?: string[];
}

export interface PolicyGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  status: PolicyGraphStatus;
  label?: string;
  pathIds?: string[];
  stepOrdinals?: number[];
}

export interface PolicyGraphDto {
  version: 1;
  capturedAt: string;
  truncated: boolean;
  omitted: { nodes: number; edges: number };
  // True only when the node/edge cap had to cut into pathIds-tagged (resolved-path) structure —
  // i.e. `omitted` is not just decorative overflow, and the returned graph may misrepresent the
  // actual resolved path. Callers MUST treat this distinctly from ordinary decorative truncation:
  // do not present the graph as a confidently-truncated-but-fine path (e.g. surface the run as
  // failed/unknown per the design's own "execution-level failure -> failed" semantics) rather than
  // silently rendering a path that might be missing its own blocking step.
  pathTruncated: boolean;
  nodes: PolicyGraphNode[];
  edges: PolicyGraphEdge[];
}

export interface GraphCaps {
  nodes: number;
  edges: number;
}

/** Stable resource-derived node id, e.g. `eni:eni-123` — keeps nodes from moving between polls. */
export function policyNodeId(kind: string, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

/** Stable edge id, e.g. `eni:eni-123->sg:sg-123` (optionally suffixed for parallel edges). */
export function policyEdgeId(source: string, target: string, suffix?: string): string {
  return suffix ? `${source}->${target}#${suffix}` : `${source}->${target}`;
}

function hasPathIds(x: { pathIds?: string[] }): boolean {
  return Array.isArray(x.pathIds) && x.pathIds.length > 0;
}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

interface PathCluster {
  minPathId: string;
  nodes: PolicyGraphNode[];
  edges: PolicyGraphEdge[];
}

/**
 * Groups path-tagged nodes/edges into connected clusters via union-find over shared `pathIds` —
 * two path ids are the same cluster the moment any single node or edge is tagged with both (a
 * shared segment between two equal-cost active paths). This is what lets `boundGraph` include or
 * exclude a whole resolved path atomically: slicing an arbitrary subset of one path's nodes can
 * leave a disconnected, misleadingly-plausible-looking fragment, but excluding/including an entire
 * cluster never can.
 */
function buildPathClusters(pathNodes: PolicyGraphNode[], pathEdges: PolicyGraphEdge[]): PathCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const ensure = (id: string) => { if (!parent.has(id)) parent.set(id, id); };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const item of [...pathNodes, ...pathEdges]) {
    const ids = item.pathIds ?? [];
    ids.forEach(ensure);
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }

  const byRoot = new Map<string, PathCluster>();
  const clusterFor = (anyPathId: string): PathCluster => {
    const root = find(anyPathId);
    let c = byRoot.get(root);
    if (!c) { c = { minPathId: anyPathId, nodes: [], edges: [] }; byRoot.set(root, c); }
    return c;
  };

  for (const n of pathNodes) clusterFor(n.pathIds![0]).nodes.push(n);
  for (const e of pathEdges) clusterFor(e.pathIds![0]).edges.push(e);

  const clusters = [...byRoot.values()];
  for (const c of clusters) {
    c.nodes.sort(byId);
    c.edges.sort(byId);
    c.minPathId = c.nodes[0]?.pathIds?.slice().sort()[0] ?? c.edges[0]?.pathIds?.slice().sort()[0] ?? c.minPathId;
  }
  return clusters.sort((a, b) => a.minPathId.localeCompare(b.minPathId));
}

/**
 * Deterministically caps a raw graph to the given node/edge limits and reports what was hidden.
 * `caps.nodes`/`caps.edges` are ALWAYS enforced as hard maximums (the returned graph never exceeds
 * them) — they exist for real persistence/rendering safety reasons (bounded Aurora JSONB size,
 * bounded browser canvas cost), and a shared function silently exceeding them under some inputs
 * would reopen exactly the unbounded-write risk the cap exists to prevent.
 *
 * Within that hard limit, resolved-path structure (`pathIds` non-empty) is preferred over
 * decorative/candidate structure — a resolved-path graph's whole point is the path, so decorative
 * overflow is dropped first. Path structure is admitted in whole connected clusters (see
 * `buildPathClusters`), never as an arbitrary node-by-node slice: a cluster is either included with
 * ALL of its nodes and edges, or excluded entirely. Slicing partway through a path/cluster would
 * leave disconnected fragments that can look like a complete, if smaller, valid result — which for
 * a security decision graph is worse than an honest, visible gap. Clusters are tried in
 * deterministic order (by their smallest `pathIds` value) and admitted greedily while both the node
 * and edge budget allow; a cluster too big for the remaining budget is skipped for a later, smaller
 * one rather than trying to fit part of it. Any cluster left out sets `pathTruncated: true` — an
 * explicit, un-ignorable signal that `omitted` this time is resolved-path structure, not just
 * decoration, so a caller can react distinctly (e.g. treat the run as failed/unknown) rather than
 * present a confidently-truncated but incomplete path. In practice full exclusion should be rare —
 * the caps are generous specifically because domain builders are expected to have already collapsed
 * repeated targets/candidate branches into typed `+N` nodes before calling this (see
 * `web/lib/sg-policy-graph.ts`).
 *
 * Decorative nodes/edges are chosen for the remaining budget by sorting on id, so repeated calls
 * over the same input are stable across polls. Dangling edges (referencing a node the node cap cut)
 * are dropped and counted as omitted the same as edges cut purely by the edge cap.
 */
export function boundGraph(
  graph: { version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[] },
  caps: GraphCaps,
): PolicyGraphDto {
  const pathNodes = graph.nodes.filter(hasPathIds);
  const pathEdges = graph.edges.filter(hasPathIds);
  const looseNodes = graph.nodes.filter((n) => !hasPathIds(n)).sort(byId);
  const looseEdges = graph.edges.filter((e) => !hasPathIds(e)).sort(byId);

  const clusters = buildPathClusters(pathNodes, pathEdges);
  const includedClusters: PathCluster[] = [];
  let usedNodes = 0;
  let usedEdges = 0;
  for (const c of clusters) {
    if (usedNodes + c.nodes.length <= caps.nodes && usedEdges + c.edges.length <= caps.edges) {
      includedClusters.push(c);
      usedNodes += c.nodes.length;
      usedEdges += c.edges.length;
    }
    // else: the whole cluster is excluded — never a partial slice of it.
  }

  const keptPathNodes = includedClusters.flatMap((c) => c.nodes).sort(byId);
  const looseNodeBudget = Math.max(0, caps.nodes - keptPathNodes.length);
  const keptNodes = [...keptPathNodes, ...looseNodes.slice(0, looseNodeBudget)].sort(byId);
  const keptNodeIds = new Set(keptNodes.map((n) => n.id));

  // Defensive re-check: an included cluster's own edges should already have both endpoints inside
  // it, but never trust that blindly against a dangling edge in malformed input.
  const keptPathEdges = includedClusters
    .flatMap((c) => c.edges)
    .filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target))
    .sort(byId);
  const looseEdgeBudget = Math.max(0, caps.edges - keptPathEdges.length);
  const keptLooseEdges = looseEdges
    .filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target))
    .slice(0, looseEdgeBudget);
  const keptEdges = [...keptPathEdges, ...keptLooseEdges].sort(byId);

  const omittedNodes = graph.nodes.length - keptNodes.length;
  const omittedEdges = graph.edges.length - keptEdges.length;

  return {
    version: 1,
    capturedAt: graph.capturedAt,
    truncated: omittedNodes > 0 || omittedEdges > 0,
    omitted: { nodes: omittedNodes, edges: omittedEdges },
    pathTruncated: includedClusters.length !== clusters.length,
    nodes: keptNodes,
    edges: keptEdges,
  };
}
