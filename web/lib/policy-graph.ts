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

/**
 * Deterministically caps a raw graph to the given node/edge limits and reports what was hidden.
 * Nodes and edges are sorted by id first so repeated calls over the same input are stable across
 * polls. Dangling edges (referencing a node cut by the node cap) are dropped and counted as
 * omitted, same as edges cut purely by the edge cap — the omitted count is a truthful "this many
 * hidden," not a distinction of reason. Does NOT collapse excess nodes into a typed `+N` node;
 * that is a domain-builder concern (e.g. `web/lib/sg-policy-graph.ts`) applied before this call.
 */
export function boundGraph(
  graph: { version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[] },
  caps: GraphCaps,
): PolicyGraphDto {
  const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const keptNodes = sortedNodes.slice(0, caps.nodes);
  const keptNodeIds = new Set(keptNodes.map((n) => n.id));

  const sortedEdges = [...graph.edges].sort((a, b) => a.id.localeCompare(b.id));
  const validEdges = sortedEdges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target));
  const keptEdges = validEdges.slice(0, caps.edges);

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
