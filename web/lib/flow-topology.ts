// Pure request-flow graph builder — reactflow-independent. Builds a front-door flow:
//   CloudFront → ALB/NLB → TargetGroup → target (instance|ip|lambda), + CF→WAF.
// Reads already-synced inventory rows flattened as { resource_id, region, ...data }.
//
// IMPORTANT (Steampipe shape): jsonb COLUMN names are snake_case, but NESTED struct keys are
// PascalCase (AWS SDK shape) — origins[].DomainName, target_health_descriptions[].Target.Id /
// .TargetHealth.State. alb/nlb resource_id is the LB *name*, so joins that use ARNs
// (tg.load_balancer_arns, cloudfront.web_acl_id) must index by the payload `arn` field.
//
// Edges carry `confidence`: Spec 1 emits only 'observed' (solid). 'inferred' (dashed) is
// reserved for Spec 2's env→RDS edges — the renderer keys stroke style off this field.

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));

/** Coerce a jsonb value that may arrive as an array or a JSON string into an array. */
function arr(v: unknown): Row[] {
  if (Array.isArray(v)) return v as Row[];
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

export type FlowKind = 'cloudfront' | 'alb' | 'nlb' | 'tg' | 'target' | 'waf' | 'origin' | 'more';
export type Confidence = 'observed' | 'inferred';
export interface FlowNode { id: string; kind: FlowKind; label: string; meta?: Record<string, unknown> }
export interface FlowEdge { id: string; source: string; target: string; confidence: Confidence }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

export interface FlowInput {
  cloudfront?: Row[]; alb?: Row[]; nlb?: Row[]; tg?: Row[]; waf?: Row[];
}

/** Max targets rendered per target group before collapsing the rest into a "+N more" node. */
export const TARGET_CAP = 20;

export function buildFlowGraph(input: FlowInput): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const ids = new Set<string>();
  const edgeIds = new Set<string>();

  const addNode = (id: string, kind: FlowKind, label: string, meta?: Record<string, unknown>) => {
    if (id.endsWith(':') || ids.has(id)) return; // skip empty resource_id + dedup
    ids.add(id);
    nodes.push({ id, kind, label, ...(meta ? { meta } : {}) });
  };
  const addEdge = (source: string, target: string, confidence: Confidence = 'observed') => {
    if (!ids.has(source) || !ids.has(target)) return; // both endpoints must be real nodes
    const id = `${source}->${target}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, source, target, confidence });
  };

  // 1) nodes first so edge endpoint checks resolve.
  for (const c of input.cloudfront ?? []) addNode(`cf:${str(c.resource_id)}`, 'cloudfront', str(c.name) || str(c.resource_id));
  for (const a of input.alb ?? []) addNode(`alb:${str(a.resource_id)}`, 'alb', str(a.dns_name) || str(a.resource_id));
  for (const n of input.nlb ?? []) addNode(`nlb:${str(n.resource_id)}`, 'nlb', str(n.dns_name) || str(n.resource_id));
  for (const w of input.waf ?? []) addNode(`waf:${str(w.resource_id)}`, 'waf', str(w.resource_id));
  for (const t of input.tg ?? []) addNode(`tg:${str(t.resource_id)}`, 'tg', str(t.target_group_name) || str(t.resource_id), { targetType: str(t.target_type) });

  // Indexes for ARN-keyed joins (LB resource_id is a name, joins use arn).
  const lbByDns = new Map<string, string>();   // lowercased dns_name → node id
  const lbByArn = new Map<string, string>();    // lb arn → node id
  const wafByArn = new Map<string, string>();   // waf arn → node id
  for (const a of input.alb ?? []) {
    if (a.dns_name) lbByDns.set(str(a.dns_name).toLowerCase(), `alb:${str(a.resource_id)}`);
    if (a.arn) lbByArn.set(str(a.arn), `alb:${str(a.resource_id)}`);
  }
  for (const n of input.nlb ?? []) {
    if (n.dns_name) lbByDns.set(str(n.dns_name).toLowerCase(), `nlb:${str(n.resource_id)}`);
    if (n.arn) lbByArn.set(str(n.arn), `nlb:${str(n.resource_id)}`);
  }
  for (const w of input.waf ?? []) if (w.arn) wafByArn.set(str(w.arn), `waf:${str(w.resource_id)}`);

  // 2) CloudFront → origins (ALB/NLB by DNS, or unresolved origin node) + CF→WAF.
  for (const c of input.cloudfront ?? []) {
    const cfId = `cf:${str(c.resource_id)}`;
    const wafArn = str(c.web_acl_id);
    if (wafArn && wafByArn.has(wafArn)) addEdge(cfId, wafByArn.get(wafArn)!);

    arr(c.origins).forEach((o, i) => {
      const domain = str(o.DomainName);
      const lbId = lbByDns.get(domain.toLowerCase());
      if (lbId) { addEdge(cfId, lbId); return; }
      // VPC origin (private LB, DomainName is the public FQDN) or any unmatched origin →
      // honest unresolved-origin node, never a false LB edge. VpcOriginConfig→ARN resolution
      // is a feasibility-gated follow-up (aws_cloudfront_vpc_origin not synced).
      const vpc = (o.VpcOriginConfig && typeof o.VpcOriginConfig === 'object') ? ' (VPC origin)' : '';
      const oid = `origin:${str(c.resource_id)}:${domain || i}`;
      addNode(oid, 'origin', `${domain || 'origin'}${vpc}`, { unresolved: true });
      addEdge(cfId, oid);
    });
  }

  // 3) ALB/NLB → TG (via load_balancer_arns) and TG → targets (target_health_descriptions).
  for (const t of input.tg ?? []) {
    const tgId = `tg:${str(t.resource_id)}`;
    // load_balancer_arns is an array of plain ARN strings (not objects) → normalize separately.
    const lbArns = Array.isArray(t.load_balancer_arns)
      ? (t.load_balancer_arns as unknown[]).map(str)
      : (typeof t.load_balancer_arns === 'string' && t.load_balancer_arns.trim().startsWith('[')
          ? (() => { try { return (JSON.parse(t.load_balancer_arns as string) as unknown[]).map(str); } catch { return []; } })()
          : []);
    for (const lbArn of lbArns) {
      const lbId = lbByArn.get(lbArn);
      if (lbId) addEdge(lbId, tgId);
    }

    const thds = arr(t.target_health_descriptions);
    const shown = thds.slice(0, TARGET_CAP);
    shown.forEach((thd, i) => {
      const target = (thd.Target && typeof thd.Target === 'object') ? (thd.Target as Row) : {};
      const health = (thd.TargetHealth && typeof thd.TargetHealth === 'object') ? (thd.TargetHealth as Row) : {};
      const targetId = str(target.Id) || `unknown-${i}`;
      const nodeId = `target:${str(t.resource_id)}:${targetId}`;
      addNode(nodeId, 'target', targetId, {
        targetType: str(t.target_type),
        health: str(health.State) || 'unknown',
        port: target.Port ?? null,
      });
      addEdge(tgId, nodeId);
    });
    if (thds.length > TARGET_CAP) {
      const moreId = `more:${str(t.resource_id)}`;
      addNode(moreId, 'more', `+${thds.length - TARGET_CAP} more targets`);
      addEdge(tgId, moreId);
    }
  }

  return { nodes, edges };
}

/**
 * BFS-reachable subtree from an entry node over outgoing edges. A CloudFront id yields its whole
 * downstream; an LB id yields ALB→TG→targets only (not the CF above it). null / unknown id → full graph.
 */
export function filterFromEntry(graph: FlowGraph, entryId: string | null): FlowGraph {
  if (!entryId || !graph.nodes.some((n) => n.id === entryId)) return graph;
  const out = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.source);
    if (list) list.push(e); else out.set(e.source, [e]);
  }
  const keep = new Set<string>([entryId]);
  const queue = [entryId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of out.get(cur) ?? []) if (!keep.has(e.target)) { keep.add(e.target); queue.push(e.target); }
  }
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}
