// Pure request-flow graph builder — reactflow-independent. Builds a front-door flow:
//   Route53 → CloudFront → ALB/NLB → TargetGroup → target (instance|ip|lambda), + CF→WAF.
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

export type FlowKind = 'route53' | 'cloudfront' | 'alb' | 'nlb' | 'tg' | 'target' | 'waf' | 'origin' | 'more';
export type Confidence = 'observed' | 'inferred';
export interface FlowNode { id: string; kind: FlowKind; label: string; meta?: Record<string, unknown> }
export interface FlowEdge { id: string; source: string; target: string; confidence: Confidence }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

export interface FlowInput {
  route53?: Row[]; cloudfront?: Row[]; alb?: Row[]; nlb?: Row[]; tg?: Row[]; waf?: Row[];
  ec2?: Row[]; lambda?: Row[]; ecsTask?: Row[];
  // s3 buckets (resource_id = bucket name, carries arn) — lets a CloudFront S3 origin resolve to
  // the REAL bucket resource (full row + ARN) instead of a synthesized placeholder.
  s3?: Row[];
  // ip-target resolution (Spec 2): pod/ENI IP → friendly label + meta. EKS comes live from the
  // page (ipResolved); ECS is derived here from synced ecsTask rows. Builder stays pure.
  ipResolved?: Record<string, { label: string; resolved: 'eks' | 'ecs'; meta?: Record<string, unknown> }>;
}

/** ECS task ENI private IP → service/task. attachments[].Details[Name=privateIPv4Address].Value (PascalCase). */
function ecsIpMap(tasks: Row[]): Map<string, { label: string; resolved: 'ecs'; meta: Record<string, unknown> }> {
  const map = new Map<string, { label: string; resolved: 'ecs'; meta: Record<string, unknown> }>();
  for (const t of tasks) {
    const group = str(t.task_group);
    const svc = group.startsWith('service:') ? group.slice(8) : group;
    const taskId = str(t.resource_id).split('/').pop() || str(t.resource_id);
    for (const att of arr(t.attachments)) {
      for (const d of arr(att.Details)) {
        if (str(d.Name) === 'privateIPv4Address' && d.Value) {
          map.set(str(d.Value), { label: svc || taskId, resolved: 'ecs', meta: { ecsService: svc, task: taskId, cluster: str(t.cluster_arn).split('/').pop() } });
        }
      }
    }
  }
  return map;
}

/** CloudFront `aliases` jsonb → string[] (PascalCase {Items:[...]} or a plain array). */
function aliasesOf(c: Row): string[] {
  const a = c.aliases;
  if (Array.isArray(a)) return a.map(str);
  if (a && typeof a === 'object' && Array.isArray((a as Row).Items)) return ((a as Row).Items as unknown[]).map(str);
  return [];
}

/** Normalize a DNS name for matching (drop trailing dot, lowercase). */
const dns = (v: unknown): string => str(v).replace(/\.$/, '').toLowerCase();

/** Max targets rendered per target group before collapsing the rest into a "+N more" node. */
export const TARGET_CAP = 20;

/** A CloudFront origin domain that is an S3 endpoint → the bucket name, else null.
 *  Matches virtual-hosted REST + website endpoints: <bucket>.s3.<region>.amazonaws.com,
 *  <bucket>.s3.amazonaws.com, <bucket>.s3-<region>.amazonaws.com, ...s3-website... */
function s3Bucket(domain: string): string | null {
  const m = domain.match(/^(.+?)\.s3[.-][^/]*amazonaws\.com$/i);
  return m ? m[1] : null;
}

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
  // LB node ids are keyed by the globally-unique ARN (resource_id is just the name, which can
  // collide across regions); the name/dns_name is the display label.
  const lbId = (kind: 'alb' | 'nlb', r: Row) => `${kind}:${str(r.arn) || str(r.resource_id)}`;

  // meta.row + meta.invType carry the full source inventory row so the UI can show every
  // field (vpc, subnet, tags, …) on click — no extra fetch.
  for (const c of input.cloudfront ?? []) {
    const al = aliasesOf(c);
    addNode(`cf:${str(c.resource_id)}`, 'cloudfront', al[0] || str(c.name) || str(c.resource_id), { row: c, invType: 'cloudfront', ...(al.length ? { aliases: al } : {}) });
  }
  for (const a of input.alb ?? []) addNode(lbId('alb', a), 'alb', str(a.dns_name) || str(a.resource_id), { row: a, invType: 'alb' });
  for (const n of input.nlb ?? []) addNode(lbId('nlb', n), 'nlb', str(n.dns_name) || str(n.resource_id), { row: n, invType: 'nlb' });
  for (const w of input.waf ?? []) addNode(`waf:${str(w.resource_id)}`, 'waf', str(w.resource_id), { row: w, invType: 'waf' });
  for (const t of input.tg ?? []) addNode(`tg:${str(t.resource_id)}`, 'tg', str(t.target_group_name) || str(t.resource_id), { targetType: str(t.target_type), row: t, invType: 'target_group' });

  // Indexes for joins (LB by dns_name for CF origins, by arn for TG load_balancer_arns).
  const lbByDns = new Map<string, string>();   // lowercased dns_name → node id
  const lbByArn = new Map<string, string>();    // lb arn → node id
  const wafByArn = new Map<string, string>();   // waf arn → node id
  for (const a of input.alb ?? []) {
    if (a.dns_name) lbByDns.set(str(a.dns_name).toLowerCase(), lbId('alb', a));
    if (a.arn) lbByArn.set(str(a.arn), lbId('alb', a));
  }
  for (const n of input.nlb ?? []) {
    if (n.dns_name) lbByDns.set(str(n.dns_name).toLowerCase(), lbId('nlb', n));
    if (n.arn) lbByArn.set(str(n.arn), lbId('nlb', n));
  }
  for (const w of input.waf ?? []) if (w.arn) wafByArn.set(str(w.arn), `waf:${str(w.resource_id)}`);

  // Backend resolution (Spec 1 slice): instance targets → EC2 name, lambda targets → function name.
  // (ip targets → ECS task / EKS deployment is Spec 2 — needs ENI/pod-IP data not synced here.)
  const ec2ById = new Map<string, string>();    // instance-id → EC2 Name (or id)
  const lambdaByArn = new Map<string, string>(); // function arn → function name
  for (const e of input.ec2 ?? []) ec2ById.set(str(e.resource_id), str(e.name) || str(e.resource_id));
  for (const l of input.lambda ?? []) if (l.arn) lambdaByArn.set(str(l.arn), str(l.resource_id) || str(l.arn));
  const ecsByIp = ecsIpMap(input.ecsTask ?? []); // ECS task ENI IP → service (from synced inventory)
  // S3 buckets by NAME (resource_id) — join key for resolving CloudFront S3 origins to the real
  // bucket row. Bucket names are globally unique, so this is region-agnostic (a us-east-1 bucket
  // fronted by an ap-northeast-2 app still matches). Depends on the s3 inventory pk being 'name'.
  const s3ByName = new Map<string, Row>();
  for (const b of input.s3 ?? []) s3ByName.set(str(b.resource_id), b);

  // CloudFront indexes for Route53 alias targets: by distribution domain (d111.cloudfront.net)
  // and by custom-domain alias (the CNAMEs on the distribution).
  const cfByDomain = new Map<string, string>(); // cloudfront domain_name → cf node id
  const cfByAlias = new Map<string, string>();  // custom-domain alias → cf node id
  for (const c of input.cloudfront ?? []) {
    const cfId = `cf:${str(c.resource_id)}`;
    if (c.domain_name) cfByDomain.set(dns(c.domain_name), cfId);
    for (const a of aliasesOf(c)) cfByAlias.set(dns(a), cfId);
  }

  // 2) Route53 → CloudFront / LB. Records are the true front door (custom domain). Match the
  // record's alias target (or the record name itself) to a CF distribution domain/alias or an
  // LB dns_name. Records that resolve to nothing we track are skipped (no orphan DNS clutter).
  for (const r of input.route53 ?? []) {
    const aliasT = (r.alias_target && typeof r.alias_target === 'object') ? (r.alias_target as Row) : {};
    const targetDns = dns(aliasT.DNSName);          // ALIAS records: where the name points
    // clean record name (r.resource_id is the composite "name TYPE"); used for label + alias match.
    const recName = dns(r.name) || dns(r.resource_id);
    const downstream =
      cfByDomain.get(targetDns) || lbByDns.get(targetDns) ||  // alias → CF / LB
      cfByAlias.get(recName);                                 // record name == a CF custom-domain alias
    if (!downstream) continue;
    const rid = `r53:${str(r.resource_id) || recName}`;
    addNode(rid, 'route53', recName || str(r.resource_id), { recordType: str(r.type), row: r, invType: 'route53' });
    addEdge(rid, downstream);
  }

  // 3) CloudFront → origins (ALB/NLB by DNS, or unresolved origin node) + CF→WAF.
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
      // S3 origin → resolve to the REAL bucket resource (full row + ARN), not a placeholder.
      // Join the synced s3 inventory by bucket name; if the bucket isn't synced (e.g. >cap, or a
      // not-yet-synced cross-region bucket), synthesize a minimal row with the canonical S3 ARN
      // (arn:aws:s3:::<bucket> — partition-only, no region/account) so ARN copy / Ask-AI still work.
      // Keep service:'s3' in BOTH branches (the Database/S3 icon is keyed on meta.service).
      const bucket = domain ? s3Bucket(domain) : null;
      if (bucket) {
        const row = s3ByName.get(bucket) ?? { resource_id: bucket, name: bucket, arn: `arn:aws:s3:::${bucket}` };
        addNode(oid, 'origin', bucket, { service: 's3', bucket, domain, invType: 's3', row });
      } else {
        addNode(oid, 'origin', `${domain || 'origin'}${vpc}`, { unresolved: true });
      }
      addEdge(cfId, oid);
    });
  }

  // 4) ALB/NLB → TG (via load_balancer_arns) and TG → targets (target_health_descriptions).
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
      // include Port: the same instance/IP can be registered on multiple ports — keep them distinct.
      const port = target.Port == null ? '' : `:${str(target.Port)}`;
      const nodeId = `target:${str(t.resource_id)}:${targetId}${port}`;
      const ttype = str(t.target_type);
      // Resolve instance→EC2 name, lambda→function name, ip→EKS/ECS workload (via ipResolved).
      let label = targetId;
      let resolved = '';
      let extra: Record<string, unknown> = {};
      if (ttype === 'instance' && ec2ById.has(targetId)) { label = ec2ById.get(targetId)!; resolved = 'ec2'; }
      else if (ttype === 'lambda' && lambdaByArn.has(targetId)) { label = lambdaByArn.get(targetId)!; resolved = 'lambda'; }
      else if (ttype === 'ip') {
        // EKS (live from page) takes priority, then ECS (synced inventory).
        const r = input.ipResolved?.[targetId] ?? ecsByIp.get(targetId);
        if (r) { label = r.label; resolved = r.resolved; extra = r.meta ?? {}; }
      }
      addNode(nodeId, 'target', label, {
        targetType: ttype,
        health: str(health.State) || 'unknown',
        port: target.Port ?? null,
        id: targetId,
        ...(resolved ? { resolved } : {}),
        ...extra,
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
