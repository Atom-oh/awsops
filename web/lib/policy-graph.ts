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

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

/**
 * Deterministically caps a raw graph to the given node/edge limits and reports what was hidden.
 *
 * A resolved-path graph's whole point is the path, so this function treats `caps` as a hard limit
 * only for decorative/candidate structure (nodes and edges with no `pathIds`) and NEVER drops a
 * node or edge that is part of an active resolved path (`pathIds` non-empty) — not even when the
 * path-tagged structure alone exceeds `caps.nodes`/`caps.edges`. A shared, domain-agnostic function
 * has no way to pick *which* path node is safe to cut without breaking the path's meaning, so the
 * only honest behavior is to never guess: exceed the nominal cap rather than silently sever a
 * result a security decision might depend on. In practice this should be rare — the caps here are
 * generous specifically because domain builders are expected to have already collapsed repeated
 * targets/candidate branches into typed `+N` nodes before calling this (see
 * `web/lib/sg-policy-graph.ts`) — but if it does happen, `truncated`/`omitted` still report the
 * (decorative-only) count actually dropped, and the returned node/edge count can legitimately
 * exceed `caps` when path-tagged structure alone requires it.
 *
 * Decorative nodes/edges are chosen for the remaining budget by sorting on id, so repeated calls
 * over the same input are stable across polls. Dangling edges (referencing a node the node cap cut)
 * are dropped and counted as omitted the same as edges cut purely by the edge cap.
 */
export function boundGraph(
  graph: { version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[] },
  caps: GraphCaps,
): PolicyGraphDto {
  const pathNodes = graph.nodes.filter(hasPathIds).sort(byId);
  const looseNodes = graph.nodes.filter((n) => !hasPathIds(n)).sort(byId);
  const looseNodeBudget = Math.max(0, caps.nodes - pathNodes.length);
  const keptNodes = [...pathNodes, ...looseNodes.slice(0, looseNodeBudget)].sort(byId);
  const keptNodeIds = new Set(keptNodes.map((n) => n.id));

  const pathEdges = graph.edges.filter(hasPathIds).sort(byId);
  const looseEdges = graph.edges.filter((e) => !hasPathIds(e)).sort(byId);
  const keptPathEdges = pathEdges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target));
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
    nodes: keptNodes,
    edges: keptEdges,
  };
}
