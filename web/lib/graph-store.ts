import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { buildFlowGraph, type FlowInput, type FlowKind } from './flow-topology';
import { buildInfraGraph, type Row } from './infra-topology';
import type { TraceSource, TraceSpan, ServiceGraphCall, SourceRead } from './trace-source';
import { buildTraceGraph, type InfraNodeLike } from './trace-graph';
import { writeGraphState, type GraphAttempt, type GraphClass } from './graph-state';
import { currentAccountId } from './account';
export { resolveInfraRef } from './trace-graph';

/** Structural (duck-typed) interface for a Prometheus/Mimir service-graph metrics source — matches
 *  trace-source.ts's `MetricsCallsSource` class without importing it directly, so tests can supply a
 *  plain stub. Contributes `calls` edges only (see graph_catalog.py's capability-driven design). */
interface MetricsCallsSourceLike {
  available(): Promise<boolean>;
  calls(windowMins: number, endMs?: number): Promise<SourceRead<ServiceGraphCall>>;
}

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
  waf: 'waf', ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask', s3: 's3', subnet: 'subnet',
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
// Pinned to clickhouse_mcp's MAX_ROWS_CAP (1000): the adapter passes max_rows=cap and the shared
// ClickHouse tool hard-caps result rows at 1000, so a larger LIMIT would be a fiction the tool
// silently truncates. Widening the shared cap for a dormant layer isn't justified (M1).
const TRACE_SPAN_CAP = 1000;
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
interface GEdge { source: string; target: string; rel: string; confidence: string; meta?: object }

// Trace keeps its existing attempt/window defaults; inventory uses rebuildInventory below.
// Both paths share the same class/account-scoped row replacement inside their transaction.
async function writeGraph(pool: Pool, cls: string, lockKey: number, accountId: string, nodes: GNode[], edges: GEdge[], runId: string, allowEmpty = false, attempt?: GraphAttempt) {
  if (nodes.length === 0 && !allowEmpty) return { nodes: 0, edges: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    if (attempt) {
      const current = await writeGraphState(client, accountId, attempt);
      if (!current || !attempt.publish) {
        await client.query('COMMIT');
        return { nodes: 0, edges: 0 };
      }
    }
    await replaceGraph(client, cls, accountId, nodes, edges, runId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { nodes: nodes.length, edges: edges.length };
}

// Only called while the class lock and transaction are held.
async function replaceGraph(client: PoolClient, cls: string, accountId: string, nodes: GNode[], edges: GEdge[], runId: string) {
  for (const n of nodes) {
    await client.query(
      `INSERT INTO topology_nodes (account_id, id, kind, label, meta, run_id, class)
       VALUES ($7, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, id, class) DO UPDATE
         SET kind = EXCLUDED.kind, label = EXCLUDED.label, meta = EXCLUDED.meta,
             run_id = EXCLUDED.run_id, captured_at = now()`,
      [n.id, n.kind, n.label, JSON.stringify(n.meta ?? {}), runId, cls, accountId],
    );
  }
  for (const e of edges) {
    const hasMetadata = e.meta !== undefined;
    await client.query(
      `INSERT INTO topology_edges (account_id, source, target, rel, confidence, run_id, class${hasMetadata ? ', meta' : ''})
       VALUES ($7, $1, $2, $3, $4, $5, $6${hasMetadata ? ', $8::jsonb' : ''})
       ON CONFLICT (account_id, source, target, rel, class) DO UPDATE
         SET confidence = EXCLUDED.confidence, run_id = EXCLUDED.run_id, captured_at = now()
             ${hasMetadata ? ', meta = EXCLUDED.meta' : ''}`,
      [e.source, e.target, e.rel, e.confidence, runId, cls, accountId,
        ...(hasMetadata ? [JSON.stringify(e.meta)] : [])],
    );
  }
  // class+account-scoped mark-sweep: drop only THIS class+account's rows not written by this run.
  await client.query(`DELETE FROM topology_edges WHERE account_id = $3 AND class = $1 AND run_id <> $2`, [cls, runId, accountId]);
  await client.query(`DELETE FROM topology_nodes WHERE account_id = $3 AND class = $1 AND run_id <> $2`, [cls, runId, accountId]);
}

type InventoryRow = Row & { resource_type: string; captured_at?: unknown; account_id: string };
const stamp = (value: unknown): number | null => {
  const ms = typeof value === 'string' || value instanceof Date ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

function inventoryAttempt(rows: InventoryRow[], runs: Record<string, any>[], types: string[], attemptedAt: string, account: string): GraphAttempt {
  const sources = types.slice(0, 128).map(type => {
    const items = rows.filter(row => row.resource_type === type);
    const direct = runs.find(row => row.resource_type === type && row.account_id === account);
    const run = direct ?? runs.find(row => row.resource_type === type && row.account_id === 'self');
    const unknownScope = account !== 'self' && !direct && !items.length;
    const captures = items.map(row => stamp(row.captured_at));
    const capturedAtMs = captures.length && captures.every(value => value !== null)
      ? captures.reduce<number>((oldest, value) => Math.min(oldest, value!), Infinity) : null;
    const lastSuccessAtMs = stamp(run?.last_success_at);
    const producerStatus = ['succeeded', 'failed', 'partial', 'running'].includes(run?.status) ? run!.status : 'unknown';
    const unknownAttributes = !Number.isSafeInteger(run?.unknown_attribute_count) || run!.unknown_attribute_count < 0
      || run!.unknown_attribute_count > 0;
    const reasons = !run ? ['missing_ledger'] : unknownScope ? ['unknown_account_coverage'] : producerStatus === 'failed' ? ['source_failed']
      : producerStatus !== 'succeeded' ? ['incomplete_collection'] : unknownAttributes ? ['unknown_attributes']
      : !items.length && run.row_count !== 0 ? ['empty_not_confirmed']
      : !lastSuccessAtMs || (items.length > 0 && capturedAtMs === null) ? ['unknown_capture'] : [];
    const status = producerStatus === 'failed' ? 'error' : producerStatus === 'unknown' || !lastSuccessAtMs || unknownScope ? 'unavailable'
      : reasons.length ? 'partial' : items.length ? 'ok' : 'empty';
    return { sourceId: `inventory:${type}`, scope: direct && account !== 'self' ? 'account' : 'aggregate', status, producerStatus, reasons,
      itemCount: items.length, capturedAtMs, lastSuccessAtMs,
      attemptedAtMs: stamp(run?.started_at), finishedAtMs: stamp(run?.finished_at) };
  });
  const status = sources.some(s => s.status === 'error') ? 'error'
    : !sources.length || sources.some(s => s.status === 'unavailable') ? 'unavailable'
    : types.length > 128 || sources.some(s => s.status === 'partial') ? 'partial' : rows.length ? 'ok' : 'empty';
  const publish = status === 'ok' || status === 'empty';
  return { status, attemptedAt, publish, details: { sources, retainedPrevious: !publish } };
}

/** The producer ledger is aggregate, keyed by self. Read it and the original rows in ONE
 * statement snapshot. The class lock serializes state + graph publication, including failures.
 * Include previously materialized accounts so a failed/zero refresh cannot strand old graphs. */
async function rebuildInventory(pool: Pool, cls: GraphClass, lock: number, runId: string,
  types: string[] | null, build: (rows: InventoryRow[]) => { nodes: GNode[]; edges: GEdge[] }) {
  const attemptedAt = new Date(Date.now()).toISOString();
  const totals = { nodes: 0, edges: 0 };
  const schema = await pool.query(`SELECT to_regclass('public.topology_graph_state') IS NOT NULL AS ready`);
  if (schema.rows[0]?.ready !== true) return totals;
  const client = await pool.connect();
  const attempts = new Map<string, GraphAttempt>();
  let accounts = ['self'];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lock]);
    const existing = await client.query(`SELECT DISTINCT account_id FROM topology_nodes WHERE class=$1
      UNION SELECT account_id FROM topology_graph_state WHERE class=$1`, [cls]);
    const prior = await client.query(`SELECT account_id, details->'publishedSources' AS sources
      FROM topology_graph_state WHERE class=$1`, [cls]);
    accounts = [...new Set(['self', ...existing.rows.map(row => row.account_id)])];
    const snapshot = await client.query(`SELECT
      (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM
        (SELECT account_id, resource_type, resource_id, region, data, captured_at FROM inventory_resources
         WHERE ($1::text[] IS NULL OR resource_type = ANY($1))) r) AS inventory,
      (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM
        (SELECT account_id, resource_type, status, started_at, finished_at, last_success_at, row_count, unknown_attribute_count
         FROM inventory_sync_runs WHERE ($1::text[] IS NULL OR resource_type = ANY($1))) r) AS runs`, [types]);
    const inventory: InventoryRow[] = snapshot.rows[0].inventory;
    const runs: Record<string, any>[] = snapshot.rows[0].runs;
    accounts = [...new Set([...accounts, ...inventory.map(row => row.account_id), ...runs.map(row => row.account_id)])];
    const required = types ?? [...new Set([...runs.map(row => row.resource_type), ...inventory.map(row => row.resource_type)])];
    for (const account of accounts) {
      const rows = inventory.filter(row => row.account_id === account);
      const directTypes = runs.filter(row => row.account_id === account).map(row => row.resource_type);
      const previousSources = prior.rows.find(row => row.account_id === account)?.sources;
      const previousTypes = Array.isArray(previousSources) ? previousSources.flatMap(source =>
        typeof source?.sourceId === 'string' && /^inventory:[a-z][a-z0-9_]{0,63}$/.test(source.sourceId)
          ? [source.sourceId.slice(10)] : []) : [];
      // Aggregate host types with no member rows are not member coverage. Carry previously used
      // types forward so disappearing member rows require their own successful-empty evidence.
      const accountTypes = account === 'self' ? required
        : [...new Set([...directTypes, ...rows.map(row => row.resource_type), ...previousTypes])];
      const attempt = inventoryAttempt(rows, runs, accountTypes, attemptedAt, account);
      attempts.set(account, attempt);
      const graph = attempt.publish ? build(rows) : { nodes: [], edges: [] };
      if (attempt.publish) attempt.status = graph.nodes.length ? 'ok' : 'empty';
      if (await writeGraphState(client, account, attempt, cls) && attempt.publish) {
        await replaceGraph(client, cls, account, graph.nodes, graph.edges, runId);
        totals.nodes += graph.nodes.length; totals.edges += graph.edges.length;
      }
    }
    await client.query('COMMIT');
    return totals;
  } catch (error) {
    await client.query('ROLLBACK');
    // The failed transaction cannot leave a success ledger. Record the failed attempt separately,
    // under the same lock/order guard; another newer publisher may already have won this race.
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [lock]);
      for (const account of accounts) {
        await writeGraphState(client, account, { attemptedAt, status: 'error', publish: false,
          details: { sources: attempts.get(account)?.details.sources ?? [], retainedPrevious: true,
            failureReason: attempts.has(account) ? 'publication_failed' : 'source_read_failed' } }, cls);
      }
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      // No false success when even failure recording is unavailable; surface failure to the worker.
    }
    throw error;
  } finally { client.release(); }
}

export async function rebuildGraph(pool: Pool, runId: string = randomUUID()) {
  return rebuildInventory(pool, 'flow', FLOW_LOCK, runId, TYPES, rows => {
    const input: FlowInput = {};
    for (const row of rows) {
      const key = TYPE_TO_KEY[row.resource_type];
      if (key) (input[key] ??= []).push({ resource_id: row.resource_id, region: row.region, ...(row.data as object ?? {}) });
    }
    const graph = buildFlowGraph(input);
    const kinds = new Map(graph.nodes.map(node => [node.id, node.kind]));
    // L7 display labels remain live-only; persisted edges keep the existing traversal contract.
    return { nodes: graph.nodes, edges: graph.edges.map(edge => ({ source: edge.source, target: edge.target,
      rel: relFor(kinds.get(edge.source), kinds.get(edge.target)), confidence: edge.confidence })) };
  });
}

export async function rebuildInfraGraph(pool: Pool, runId: string = randomUUID()) {
  return rebuildInventory(pool, 'infra', INFRA_LOCK, runId, null, rows => {
    const graph = buildInfraGraph({
      resources: rows.filter(row => !NET_TYPES.includes(row.resource_type)),
      vpcs: rows.filter(row => row.resource_type === 'vpc'),
      subnets: rows.filter(row => row.resource_type === 'subnet'),
      securityGroups: rows.filter(row => row.resource_type === 'security_group'),
    });
    return { nodes: graph.nodes, edges: graph.edges.map(edge => ({ source: edge.source, target: edge.target,
      rel: edge.rel, confidence: 'observed' })) };
  });
}

// Trace collection and materialization share one explicit evidence window.
export async function rebuildTraceGraph(
  pool: Pool,
  sources: TraceSource[],
  runId: string = randomUUID(),
  metricsSources: MetricsCallsSourceLike[] = [],
): Promise<{ nodes: number; edges: number }> {
  const schema = await pool.query(
    `SELECT to_regclass('public.topology_graph_state') IS NOT NULL AS ready`,
  );
  if (schema.rows[0]?.ready !== true) return { nodes: 0, edges: 0 };
  const endMs = Date.now();
  const startMs = endMs - TRACE_WINDOW_MINS * 60_000;
  const failed = <T>(sourceId: string): SourceRead<T> => ({
    sourceId, items: [], status: 'error', reasons: ['source_failed'],
    windowStartMs: startMs, windowEndMs: endMs,
  });
  // Adapter status, not a separate readiness probe, distinguishes absent config from a failed read.
  const spanReads = await Promise.all(sources.map(async (source, i) => {
    try { return await source.recentSpans(TRACE_WINDOW_MINS, TRACE_SPAN_CAP, endMs); }
    catch { return failed<TraceSpan>(`trace:${i}`); }
  }));
  const metricReads = await Promise.all(metricsSources.map(async (source, i) => {
    try { return await source.calls(TRACE_WINDOW_MINS, endMs); }
    catch { return failed<ServiceGraphCall>(`metrics:${i}`); }
  }));
  const reads = [...spanReads, ...metricReads];
  const sourceDetails = reads.map((read) => ({
    sourceId: read.sourceId, status: read.status, reasons: read.reasons,
    itemCount: read.items.length, windowStartMs: read.windowStartMs, windowEndMs: read.windowEndMs,
  }));
  const hasFailure = reads.some((read) => read.status === 'error' || read.status === 'unavailable');
  const partial = reads.some((read) => read.status === 'partial');
  const spans = spanReads.flatMap((read) => read.items.map((span) => ({ ...span, sourceId: span.sourceId ?? read.sourceId })));
  const calls = metricReads.flatMap((read) => read.items.map((call) => ({
    ...call,
    clientIdentity: { ...call.clientIdentity, sourceId: call.clientIdentity?.sourceId ?? read.sourceId },
    serverIdentity: { ...call.serverIdentity, sourceId: call.serverIdentity?.sourceId ?? read.sourceId },
  })));
  if (!reads.length || hasFailure || (partial && !spans.length && !calls.length)) {
    const status = reads.some((read) => read.status === 'error') ? 'error'
      : partial ? 'partial' : 'unavailable';
    return writeGraph(pool, 'trace', TRACE_LOCK, 'self', [], [], runId, true, {
      status, attemptedAt: new Date(endMs).toISOString(), publish: false,
      details: { sources: sourceDetails, retainedPrevious: true, windowStartMs: startMs, windowEndMs: endMs },
    });
  }
  let infraNodes: InfraNodeLike[] = [];
  let infraUnavailable = false;
  try {
    const result = await pool.query(
      `SELECT id, kind, meta FROM topology_nodes WHERE account_id = 'self' AND class = 'infra'`,
    );
    infraNodes = result.rows as InfraNodeLike[];
  } catch { infraUnavailable = true; }
  const graph = buildTraceGraph(spans, calls, infraNodes, currentAccountId());
  // Preserve structurally important DB/queue/workload nodes before ranking service volume.
  const rank = (kind: string) => kind === 'service' ? 0 : 1;
  const nodes = graph.nodes.sort((a, b) => rank(b.kind) - rank(a.kind)
    || Number(b.meta.spanCount ?? 0) - Number(a.meta.spanCount ?? 0)).slice(0, TRACE_NODE_CAP);
  const kept = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target))
    .sort((a, b) => (b.meta.spanCount + b.meta.metricCount) - (a.meta.spanCount + a.meta.metricCount))
    .slice(0, TRACE_EDGE_CAP);
  const nodeDrops = graph.nodes.length - nodes.length;
  const edgeDrops = graph.edges.length - edges.length;
  const incomplete = partial || infraUnavailable || nodeDrops > 0 || edgeDrops > 0
    || graph.orphanSpans > 0 || graph.invalidSpans > 0 || graph.unresolvedMessaging > 0;
  const status = incomplete ? 'partial' : nodes.length ? 'ok' : 'empty';
  return writeGraph(pool, 'trace', TRACE_LOCK, 'self', nodes, edges, runId, true, {
    status, attemptedAt: new Date(endMs).toISOString(), publish: true,
    details: {
      sources: sourceDetails, retainedPrevious: false, windowStartMs: startMs, windowEndMs: endMs,
      nodeDrops, edgeDrops, orphanSpans: graph.orphanSpans, invalidSpans: graph.invalidSpans,
      unresolvedMessaging: graph.unresolvedMessaging,
      infraUnavailable,
    },
  });
}
