import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildFlowGraph, type FlowInput, type FlowKind } from './flow-topology';

// ADR-043 Step 1 materializer: read synced inventory from Aurora → reuse the SAME flow-topology
// builder the UI uses (no rule duplication) → upsert the derived graph into topology_nodes/edges
// under one advisory-locked transaction with mark-sweep deletion. Runs OFF the BFF request path
// (thin-BFF mandate) — invoked by scripts/v2/graph-rebuild.mjs (and a future post-sync lambda).
// EKS pods are live in-cluster, not synced → not materialized here (the UI resolves them live).

// Exclude 'ipResolved' (a Record, not a Row[]) so input[key] narrows to Row[] for the push below.
const TYPE_TO_KEY: Record<string, Exclude<keyof FlowInput, 'ipResolved'>> = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg',
  waf: 'waf', ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask',
};
const TYPES = Object.keys(TYPE_TO_KEY);
const LOCK_KEY = 0x746f706f; // 'topo' — arbitrary constant so concurrent rebuilds serialize

// Relationship label derived from the endpoint node kinds (the builder edges are untyped).
function relFor(sk: FlowKind | undefined, tk: FlowKind | undefined): string {
  if (sk === 'route53') return 'ROUTES_TO';
  if (sk === 'cloudfront') return tk === 'waf' ? 'PROTECTED_BY' : 'ORIGIN';
  if (sk === 'alb' || sk === 'nlb') return 'TARGETS';
  if (sk === 'tg') return 'TARGETS';
  return 'EDGE';
}

// runId is a UUID, not Date.now(): two rebuilds in the same millisecond would otherwise share an id,
// and the mark-sweep (run_id <> $1) would then fail to drop the prior run's stale rows.
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
  // Safety: an empty build almost always means inventory wasn't synced yet (or a failed/partial read),
  // not a genuinely empty environment. Sweeping now would wipe the last-good materialized graph, so we
  // skip the destructive rebuild entirely and preserve what's there. (consensus gate MAJOR finding)
  if (g.nodes.length === 0) return { nodes: 0, edges: 0 };
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]); // serialize rebuilds
    for (const n of g.nodes) {
      await client.query(
        `INSERT INTO topology_nodes (account_id, id, kind, label, meta, run_id)
         VALUES ('self', $1, $2, $3, $4, $5)
         ON CONFLICT (account_id, id) DO UPDATE
           SET kind = EXCLUDED.kind, label = EXCLUDED.label, meta = EXCLUDED.meta,
               run_id = EXCLUDED.run_id, captured_at = now()`,
        [n.id, n.kind, n.label, JSON.stringify(n.meta ?? {}), runId],
      );
    }
    for (const e of g.edges) {
      await client.query(
        `INSERT INTO topology_edges (account_id, source, target, rel, confidence, run_id)
         VALUES ('self', $1, $2, $3, $4, $5)
         ON CONFLICT (account_id, source, target, rel) DO UPDATE
           SET confidence = EXCLUDED.confidence, run_id = EXCLUDED.run_id, captured_at = now()`,
        [e.source, e.target, relFor(kindOf.get(e.source), kindOf.get(e.target)), e.confidence, runId],
      );
    }
    // mark-sweep: drop everything not written by this run (resources that disappeared)
    await client.query(`DELETE FROM topology_edges WHERE account_id = 'self' AND run_id <> $1`, [runId]);
    await client.query(`DELETE FROM topology_nodes WHERE account_id = 'self' AND run_id <> $1`, [runId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { nodes: g.nodes.length, edges: g.edges.length };
}
