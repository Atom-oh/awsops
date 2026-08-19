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

/**
 * Deterministically caps a raw graph to the given node/edge limits and reports what was hidden.
 * `caps.nodes`/`caps.edges` are ALWAYS enforced as hard maximums (the returned graph never exceeds
 * them) — they exist for real persistence/rendering safety reasons (bounded Aurora JSONB size,
 * bounded browser canvas cost), and a shared function silently exceeding them under some inputs
 * would reopen exactly the unbounded-write risk the cap exists to prevent.
 *
 * Within that hard limit, nodes/edges tagged with an active resolved path (`pathIds` non-empty)
 * are preferred over decorative/candidate ones — a resolved-path graph's whole point is the path,
 * so decorative overflow is dropped first. But when path-tagged structure ALONE still exceeds the
 * cap, this function has no way to safely guess which path node is droppable without risking a
 * misrepresented result, so instead of guessing it cuts deterministically (by id) like everything
 * else AND sets `pathTruncated: true` — an explicit, un-ignorable signal that `omitted` this time
 * includes resolved-path structure, not just decoration. Callers own the consequence (e.g. treating
 * the run as failed/unknown rather than presenting a confidently-truncated path); this function's
 * job is only to never let that happen silently in either direction (unbounded growth, or a quietly
 * wrong path). In practice this should be rare — the caps are generous specifically because domain
 * builders are expected to have already collapsed repeated targets/candidate branches into typed
 * `+N` nodes before calling this (see `web/lib/sg-policy-graph.ts`).
 *
 * Nodes/edges are chosen for their budget by sorting on id, so repeated calls over the same input
 * are stable across polls. Dangling edges (referencing a node the node cap cut) are dropped and
 * counted as omitted the same as edges cut purely by the edge cap.
 */
export function boundGraph(
  graph: { version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[] },
  caps: GraphCaps,
): PolicyGraphDto {
  const pathNodes = graph.nodes.filter(hasPathIds).sort(byId);
  const looseNodes = graph.nodes.filter((n) => !hasPathIds(n)).sort(byId);
  const keptPathNodes = pathNodes.slice(0, caps.nodes);
  const looseNodeBudget = Math.max(0, caps.nodes - keptPathNodes.length);
  const keptNodes = [...keptPathNodes, ...looseNodes.slice(0, looseNodeBudget)].sort(byId);
  const keptNodeIds = new Set(keptNodes.map((n) => n.id));

  const pathEdges = graph.edges.filter(hasPathIds).sort(byId);
  const looseEdges = graph.edges.filter((e) => !hasPathIds(e)).sort(byId);
  const validPathEdges = pathEdges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target));
  const keptPathEdges = validPathEdges.slice(0, caps.edges);
  const looseEdgeBudget = Math.max(0, caps.edges - keptPathEdges.length);
  const keptLooseEdges = looseEdges
    .filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target))
    .slice(0, looseEdgeBudget);
  const keptEdges = [...keptPathEdges, ...keptLooseEdges].sort(byId);

  const omittedNodes = graph.nodes.length - keptNodes.length;
  const omittedEdges = graph.edges.length - keptEdges.length;
  const pathNodesOmitted = pathNodes.length - keptPathNodes.length;
  const pathEdgesOmitted = pathEdges.length - keptPathEdges.length;

  return {
    version: 1,
    capturedAt: graph.capturedAt,
    truncated: omittedNodes > 0 || omittedEdges > 0,
    omitted: { nodes: omittedNodes, edges: omittedEdges },
    pathTruncated: pathNodesOmitted > 0 || pathEdgesOmitted > 0,
    nodes: keptNodes,
    edges: keptEdges,
  };
}
