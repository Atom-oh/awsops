import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildFlowGraph, type FlowInput, type FlowKind } from './flow-topology';
import { buildInfraGraph, type Row } from './infra-topology';
import type { TraceSource, TraceSpan } from './trace-source';

// ADR-043 materializer: read synced inventory from Aurora → reuse the SAME builders the UI uses
// (no rule duplication) → upsert the derived graph into topology_nodes/edges under one
// advisory-locked transaction with class-scoped mark-sweep. Runs OFF the BFF request path
// (thin-BFF mandate) — invoked by scripts/v2/graph-rebuild.mjs (and the post-sync worker job).
// Step 1 = traffic-flow (class='flow', buildFlowGraph). Step 2 = resource-relationship
// (class='infra', buildInfraGraph). The two classes share the tables but are key-distinct
// (class is in the node PK + edge UNIQUE), so each rebuild mark-sweeps ONLY its own class.
// EKS pods are live in-cluster, not synced → not materialized here (the UI resolves them live).

// Exclude 'ipResolved' (a Record, not a Row[]) so input[key] narrows to Row[] for the push below.
const TYPE_TO_KEY: Record<string, Exclude<keyof FlowInput, 'ipResolved'>> = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg',
  waf: 'waf', ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask', s3: 's3',
  // L7 origin resolution: API Gateway (→Lambda/VPC-Link→LB) + CloudFront VPC origins (→ALB/NLB).
  apigatewayv2_api: 'apigatewayv2_api', apigatewayv2_integration: 'apigatewayv2_integration',
  cloudfront_vpc_origin: 'cloudfront_vpc_origin',
};
const TYPES = Object.keys(TYPE_TO_KEY);
const FLOW_LOCK = 0x746f706f;   // 'topo' — flow rebuilds serialize on this key
const INFRA_LOCK = 0x696e6672;  // 'infr' — infra rebuilds use a DISTINCT key so the two can run concurrently
const TRACE_LOCK = 0x74726163;  // 'trac' — trace rebuilds use a DISTINCT key (class='trace' layer)
const NET_TYPES = ['vpc', 'subnet', 'security_group'];
// Trace-layer aggregation bounds — cap top-N nodes/edges; drops are logged (no silent truncation).
const TRACE_WINDOW_MINS = 60;
const TRACE_SPAN_CAP = 20000;
const TRACE_NODE_CAP = 200;
const TRACE_EDGE_CAP = 500;

// Relationship label for a flow edge, derived from the endpoint node kinds (builder edges are untyped).
function relFor(sk: FlowKind | undefined, tk: FlowKind | undefined): string {
  if (sk === 'route53') return 'ROUTES_TO';
  if (sk === 'cloudfront') return tk === 'waf' ? 'PROTECTED_BY' : 'ORIGIN';
  if (sk === 'alb' || sk === 'nlb') return 'TARGETS';
  if (sk === 'tg') return 'TARGETS';
  return 'EDGE';
}

interface GNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface GEdge { source: string; target: string; rel: string; confidence: string }

// Shared writer: one advisory-locked tx, class-scoped upsert + mark-sweep. The empty-build guard
// preserves the last-good graph when inventory is unsynced/failed (skip the destructive sweep) — this
// is RIGHT for flow/infra (a transient empty fetch must not wipe a live graph). The trace layer is the
// exception: an intentionally-empty build (source unavailable) MUST sweep its stale rows, so it passes
// `allowEmpty = true`. Default false keeps the flow/infra guard verbatim (one writer, no duplicate sweep).
async function writeGraph(pool: Pool, cls: string, lockKey: number, nodes: GNode[], edges: GEdge[], runId: string, allowEmpty = false) {
  if (nodes.length === 0 && !allowEmpty) return { nodes: 0, edges: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    for (const n of nodes) {
      await client.query(
        `INSERT INTO topology_nodes (account_id, id, kind, label, meta, run_id, class)
         VALUES ('self', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, id, class) DO UPDATE
           SET kind = EXCLUDED.kind, label = EXCLUDED.label, meta = EXCLUDED.meta,
               run_id = EXCLUDED.run_id, captured_at = now()`,
        [n.id, n.kind, n.label, JSON.stringify(n.meta ?? {}), runId, cls],
      );
    }
    for (const e of edges) {
      await client.query(
        `INSERT INTO topology_edges (account_id, source, target, rel, confidence, run_id, class)
         VALUES ('self', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, source, target, rel, class) DO UPDATE
           SET confidence = EXCLUDED.confidence, run_id = EXCLUDED.run_id, captured_at = now()`,
        [e.source, e.target, e.rel, e.confidence, runId, cls],
      );
    }
    // class-scoped mark-sweep: drop only THIS class's rows not written by this run.
    await client.query(`DELETE FROM topology_edges WHERE account_id = 'self' AND class = $1 AND run_id <> $2`, [cls, runId]);
    await client.query(`DELETE FROM topology_nodes WHERE account_id = 'self' AND class = $1 AND run_id <> $2`, [cls, runId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { nodes: nodes.length, edges: edges.length };
}

// Step 1 — traffic-flow graph (class='flow').
export async function rebuildGraph(pool: Pool, runId: string = randomUUID()): Promise<{ nodes: number; edges: number }> {
  const inv = await pool.query(
    `SELECT resource_type, resource_id, region, data FROM inventory_resources
     WHERE account_id = 'self' AND resource_type = ANY($1)`,
    [TYPES],
  );
  const input: FlowInput = {};
  for (const r of inv.rows as { resource_type: string; resource_id: unknown; region: unknown; data?: object }[]) {
    const key = TYPE_TO_KEY[r.resource_type];
    if (!key) continue;
    (input[key] ??= []).push({ resource_id: r.resource_id, region: r.region, ...(r.data ?? {}) });
  }
  const g = buildFlowGraph(input);
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  // NOTE: FlowEdge.label (L7 ALB path/host:port + API GW route_key) is intentionally NOT persisted —
  // the materialized graph is a TRAVERSAL structure (topology_edges has no label column); the L7
  // labels are a LIVE-only display feature rendered client-side on /topology from buildFlowGraph.
  const edges: GEdge[] = g.edges.map((e) => ({
    source: e.source, target: e.target,
    rel: relFor(kindOf.get(e.source), kindOf.get(e.target)), confidence: e.confidence,
  }));
  return writeGraph(pool, 'flow', FLOW_LOCK, g.nodes, edges, runId);
}

// Step 2 — resource-relationship graph (class='infra').
export async function rebuildInfraGraph(pool: Pool, runId: string = randomUUID()): Promise<{ nodes: number; edges: number }> {
  const inv = await pool.query(
    `SELECT resource_type, resource_id, region, data FROM inventory_resources WHERE account_id = 'self'`,
  );
  const rows = inv.rows as Row[];
  const isNet = (t: unknown) => NET_TYPES.includes(String(t));
  const g = buildInfraGraph({
    resources: rows.filter((r) => !isNet(r.resource_type)),
    vpcs: rows.filter((r) => r.resource_type === 'vpc'),
    subnets: rows.filter((r) => r.resource_type === 'subnet'),
    securityGroups: rows.filter((r) => r.resource_type === 'security_group'),
  });
  const edges: GEdge[] = g.edges.map((e) => ({ source: e.source, target: e.target, rel: e.rel, confidence: 'observed' }));
  return writeGraph(pool, 'infra', INFRA_LOCK, g.nodes, edges, runId);
}

// --- Step 3 — trace-level (application) graph (class='trace') -------------------------------------
// A service call-graph derived from distributed traces (otel first), built OFF the BFF like flow/infra.
// Dormant until the otel pipeline lands spans: source.available()===false → an empty layer that STILL
// sweeps stale trace rows (allowEmpty), never touching flow/infra. See the 2026-06-25 trace-topology spec.

interface InfraNodeLike { id: string; kind?: string; meta?: Record<string, unknown> | null }

// Pure bridge-ref matcher: resolve a trace db host against the current infra-layer nodes → the infra
// RDS/Aurora node id whose meta.host matches. Matching is SAFE (no arbitrary bidirectional substring,
// which false-matched short hosts like "db" against "database.rds.amazonaws.com"): we accept an exact
// host match, OR a leading-DNS-label match where the trace host is the first label of the infra host
// (e.g. "awsops-v2-aurora" → "awsops-v2-aurora.cluster-xyz.…rds.amazonaws.com"). Unmatched → undefined
// (the db node is still emitted, just without meta.infra_ref). No DB access — unit-testable on inputs.
export function resolveInfraRef(dbHost: string | undefined, infraNodes: InfraNodeLike[]): string | undefined {
  if (!dbHost) return undefined;
  const host = String(dbHost).toLowerCase();
  if (!host) return undefined;
  for (const n of infraNodes) {
    const nh = String((n.meta as Record<string, unknown> | undefined)?.host ?? '').toLowerCase();
    if (!nh) continue;
    if (nh === host) return n.id;
    // Leading-label match: the trace host equals the first DNS label of the infra host, OR is a
    // dotted prefix of it (`${host}.` is a real label boundary — never a mid-label substring).
    if (nh.split('.')[0] === host || nh.startsWith(`${host}.`)) return n.id;
  }
  return undefined;
}

export async function rebuildTraceGraph(
  pool: Pool,
  source: TraceSource,
  runId: string = randomUUID(),
): Promise<{ nodes: number; edges: number }> {
  // No-op path (the default pre-tracing state): empty trace layer, but DO sweep stale trace rows.
  if (!(await source.available())) {
    return writeGraph(pool, 'trace', TRACE_LOCK, [], [], runId, true);
  }

  const spans = await source.recentSpans(TRACE_WINDOW_MINS, TRACE_SPAN_CAP);

  // Resolve bridge refs against the current infra-layer nodes (best-effort; failure is non-fatal).
  let infraNodes: InfraNodeLike[] = [];
  try {
    const r = await pool.query(
      `SELECT id, kind, meta FROM topology_nodes WHERE account_id = 'self' AND class = 'infra'`,
    );
    infraNodes = r.rows as InfraNodeLike[];
  } catch {
    infraNodes = [];
  }

  // Index spans by spanId so a child can look up its parent's service (the calls edge).
  const byId = new Map<string, TraceSpan>();
  for (const s of spans) byId.set(s.spanId, s);

  const nodes = new Map<string, GNode>();
  const edgeCounts = new Map<string, { source: string; target: string; rel: string; n: number }>();
  const bump = (source: string, target: string, rel: string) => {
    const k = `${source} ${target} ${rel}`;
    const e = edgeCounts.get(k);
    if (e) e.n += 1; else edgeCounts.set(k, { source, target, rel, n: 1 });
  };
  const svcId = (svc: string) => `svc:${svc}`;
  const dbId = (sys: string, hostOrName: string) => `db:${sys}:${hostOrName}`;
  const wlId = (ns: string, dep: string) => `workload:${ns}/${dep}`;
  const svcSpanCount = new Map<string, number>();

  for (const s of spans) {
    if (!s.service) continue;
    const sid = svcId(s.service);
    svcSpanCount.set(sid, (svcSpanCount.get(sid) ?? 0) + 1);
    if (!nodes.has(sid)) {
      nodes.set(sid, { id: sid, kind: 'service', label: s.service, meta: { spanCount: 0 } });
    }
    // service → service (calls): parent span's service → this span's service when both differ
    if (s.parentSpanId) {
      const parent = byId.get(s.parentSpanId);
      if (parent?.service && parent.service !== s.service) {
        const psid = svcId(parent.service);
        if (!nodes.has(psid)) nodes.set(psid, { id: psid, kind: 'service', label: parent.service, meta: { spanCount: 0 } });
        bump(psid, sid, 'calls');
      }
    }
    // service → db (queries): a DB-client span carries db.system
    if (s.dbSystem) {
      const hostOrName = s.dbHost || s.dbName || 'unknown';
      const id = dbId(s.dbSystem, hostOrName);
      if (!nodes.has(id)) {
        const infra_ref = resolveInfraRef(s.dbHost, infraNodes);
        const meta: Record<string, unknown> = { system: s.dbSystem, host: s.dbHost ?? null };
        if (s.dbName) meta.dbName = s.dbName;
        if (infra_ref) meta.infra_ref = infra_ref;
        nodes.set(id, { id, kind: 'db', label: `${s.dbSystem}:${hostOrName}`, meta });
      }
      bump(sid, id, 'queries');
    }
    // service → workload (runs_on): the workload the span originates from (k8s attrs)
    if (s.k8sNamespace && s.k8sDeployment) {
      const id = wlId(s.k8sNamespace, s.k8sDeployment);
      if (!nodes.has(id)) {
        // workload eks_ref/tg_ref bridge refs are best-effort; EKS node data isn't readily queryable
        // here (pods are live in-cluster, not synced). TODO(trace-topology): resolve eks_ref/tg_ref.
        const meta: Record<string, unknown> = { namespace: s.k8sNamespace, deployment: s.k8sDeployment, pods: [] as string[] };
        nodes.set(id, { id, kind: 'workload', label: `${s.k8sNamespace}/${s.k8sDeployment}`, meta });
      }
      if (s.k8sPod) {
        const pods = (nodes.get(id)!.meta!.pods as string[]);
        if (!pods.includes(s.k8sPod)) pods.push(s.k8sPod);
      }
      bump(sid, id, 'runs_on');
    }
  }

  // Stamp service spanCount.
  for (const [id, c] of svcSpanCount) {
    const n = nodes.get(id);
    if (n?.meta) n.meta.spanCount = c;
  }

  // Cap top-N (by span/edge volume) and note drops — no silent truncation.
  let nodeList = [...nodes.values()];
  let edgeList = [...edgeCounts.values()];
  const nodeDrops = Math.max(0, nodeList.length - TRACE_NODE_CAP);
  const edgeDrops = Math.max(0, edgeList.length - TRACE_EDGE_CAP);
  if (nodeDrops > 0) {
    // Rank by node kind FIRST (db/workload are structurally important and carry spanCount 0 → ranking
    // by spanCount alone would drop them before trivial services), then by spanCount within a kind.
    const kindRank = (k: string) => (k === 'db' ? 2 : k === 'workload' ? 1 : 0); // services last
    nodeList = nodeList
      .sort((a, b) =>
        kindRank(b.kind) - kindRank(a.kind) ||
        Number((b.meta?.spanCount as number) ?? 0) - Number((a.meta?.spanCount as number) ?? 0))
      .slice(0, TRACE_NODE_CAP);
  }
  if (edgeDrops > 0) {
    edgeList = edgeList.sort((a, b) => b.n - a.n).slice(0, TRACE_EDGE_CAP);
  }
  if (nodeDrops > 0 || edgeDrops > 0) {
    console.warn(`[graph-rebuild] trace cap: dropped ${nodeDrops} nodes, ${edgeDrops} edges (caps ${TRACE_NODE_CAP}/${TRACE_EDGE_CAP})`);
  }
  // Drop edges whose endpoints were capped out.
  const keep = new Set(nodeList.map((n) => n.id));
  edgeList = edgeList.filter((e) => keep.has(e.source) && keep.has(e.target));

  const edges: GEdge[] = edgeList.map((e) => ({ source: e.source, target: e.target, rel: e.rel, confidence: String(e.n) }));
  return writeGraph(pool, 'trace', TRACE_LOCK, nodeList, edges, runId, true);
}
