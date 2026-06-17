import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildFlowGraph, type FlowInput, type FlowKind } from './flow-topology';
import { buildInfraGraph, type Row } from './infra-topology';

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
};
const TYPES = Object.keys(TYPE_TO_KEY);
const FLOW_LOCK = 0x746f706f;   // 'topo' — flow rebuilds serialize on this key
const INFRA_LOCK = 0x696e6672;  // 'infr' — infra rebuilds use a DISTINCT key so the two can run concurrently
const NET_TYPES = ['vpc', 'subnet', 'security_group'];

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
// preserves the last-good graph when inventory is unsynced/failed (skip the destructive sweep).
async function writeGraph(pool: Pool, cls: string, lockKey: number, nodes: GNode[], edges: GEdge[], runId: string) {
  if (nodes.length === 0) return { nodes: 0, edges: 0 };
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
