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

/**
 * Deterministically caps a raw graph to the given node/edge limits and reports what was hidden.
 *
 * A resolved-path graph's whole point is the path — so truncation must never treat a node that is
 * part of an active resolved path (`pathIds` non-empty) as equally droppable as an unrelated
 * candidate/exploration node. Nodes and edges tagged with `pathIds` are kept ahead of untagged
 * ones; only once that pool is exhausted does the cap start dropping path-tagged structure (which,
 * given the generous caps this is meant to enforce, should only happen for pathologically large
 * paths — this function still degrades deterministically rather than throwing, but callers should
 * treat `truncated` firing on `pathIds`-bearing nodes as a signal worth surfacing distinctly).
 * Within each tier, sorting is by id so repeated calls over the same input are stable across polls.
 *
 * Dangling edges (referencing a node cut by the node cap) are dropped and counted as omitted, same
 * as edges cut purely by the edge cap — the omitted count is a truthful "this many hidden," not a
 * distinction of reason. Does NOT collapse excess nodes into a typed `+N` node; that is a
 * domain-builder concern (e.g. `web/lib/sg-policy-graph.ts`) applied before this call.
 */
export function boundGraph(
  graph: { version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[] },
  caps: GraphCaps,
): PolicyGraphDto {
  const byPathThenId = <T extends { id: string; pathIds?: string[] }>(a: T, b: T): number => {
    const pa = hasPathIds(a) ? 0 : 1;
    const pb = hasPathIds(b) ? 0 : 1;
    return pa !== pb ? pa - pb : a.id.localeCompare(b.id);
  };

  const prioritizedNodes = [...graph.nodes].sort(byPathThenId);
  const keptNodes = prioritizedNodes.slice(0, caps.nodes);
  const keptNodeIds = new Set(keptNodes.map((n) => n.id));

  const prioritizedEdges = [...graph.edges].sort(byPathThenId);
  const validEdges = prioritizedEdges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target));
  const keptEdges = validEdges.slice(0, caps.edges);

  const omittedNodes = graph.nodes.length - keptNodes.length;
  const omittedEdges = graph.edges.length - keptEdges.length;

  return {
    version: 1,
    capturedAt: graph.capturedAt,
    truncated: omittedNodes > 0 || omittedEdges > 0,
    omitted: { nodes: omittedNodes, edges: omittedEdges },
    nodes: keptNodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: keptEdges.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
