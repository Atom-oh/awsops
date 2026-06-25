import { describe, it, expect, vi } from 'vitest';
// FakeTraceSource lives in trace-source.ts, which transitively imports datasources →
// integration-credentials (aws-sdk). Stub those so this DB-aggregation test needs no AWS SDK.
vi.mock('@/lib/datasources', () => ({
  getDefaultDatasource: vi.fn(async () => null),
  resolveConnConfig: vi.fn(async () => ({})),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: vi.fn(async () => ({ rows: [] })) }));
import { rebuildTraceGraph, resolveInfraRef } from './graph-store';
import { FakeTraceSource, type TraceSpan } from './trace-source';

// A pool that records every client.query call (sql + params) and lets the inventory/infra SELECT
// (pool.query) return a seeded row set, mirroring graph-store.test.ts's mockPool.
function mockPool(infraNodeRows: unknown[] = []) {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const client = {
    query: vi.fn((sql: string, p?: unknown[]) => { calls.push(String(sql)); if (p) params.push(p); return Promise.resolve({ rows: [] }); }),
    release: vi.fn(),
  };
  const pool = {
    // rebuildTraceGraph may query infra nodes for bridge-ref resolution
    query: vi.fn(() => Promise.resolve({ rows: infraNodeRows })),
    connect: vi.fn(() => Promise.resolve(client)),
  };
  return { pool, client, calls, params };
}

const span = (over: Partial<TraceSpan>): TraceSpan => ({
  traceId: 't', spanId: 's', service: 'svc', kind: 'SERVER', startMs: 0, durationMs: 1, ...over,
});

describe('rebuildTraceGraph aggregation', () => {
  // checkout(svc) → orders(svc) → postgres(db); checkout runs on k8s workload shop/checkout
  const spans: TraceSpan[] = [
    span({ traceId: 'x', spanId: 'p', service: 'checkout', k8sNamespace: 'shop', k8sPod: 'checkout-1', k8sDeployment: 'checkout' }),
    span({ traceId: 'x', spanId: 'c', parentSpanId: 'p', service: 'orders' }),
    span({ traceId: 'x', spanId: 'q', parentSpanId: 'c', service: 'orders', dbSystem: 'postgresql', dbHost: 'aurora.rds', dbName: 'orders' }),
  ];

  it('produces service/db/workload nodes + calls/queries/runs_on edges (class=trace)', async () => {
    const { pool, client, params } = mockPool();
    const res = await rebuildTraceGraph(pool as never, new FakeTraceSource(spans, true), 'RUNT');

    // upserts went out with class='trace'
    expect(params.some((p) => p.includes('trace'))).toBe(true);
    expect(params.some((p) => p.includes('flow') || p.includes('infra'))).toBe(false);

    // node ids inserted
    const allParams = params.flat().map(String);
    expect(allParams).toContain('svc:checkout');
    expect(allParams).toContain('svc:orders');
    expect(allParams.some((s) => s.startsWith('db:postgresql:'))).toBe(true);
    expect(allParams).toContain('workload:shop/checkout');

    // edges: calls (checkout→orders), queries (orders→db), runs_on (checkout→workload)
    expect(allParams).toContain('calls');
    expect(allParams).toContain('queries');
    expect(allParams).toContain('runs_on');

    expect(res.nodes).toBeGreaterThan(0);
    expect(res.edges).toBeGreaterThan(0);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('COMMIT'));
  });

  it('confidence reflects span counts (string)', async () => {
    // two checkout→orders call edges should aggregate to count 2
    const dup: TraceSpan[] = [
      span({ traceId: 'a', spanId: 'p1', service: 'checkout' }),
      span({ traceId: 'a', spanId: 'c1', parentSpanId: 'p1', service: 'orders' }),
      span({ traceId: 'b', spanId: 'p2', service: 'checkout' }),
      span({ traceId: 'b', spanId: 'c2', parentSpanId: 'p2', service: 'orders' }),
    ];
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, new FakeTraceSource(dup, true), 'RUNT2');
    // confidence is a string; the calls edge between checkout/orders carries count "2"
    const edgeParams = params.filter((p) => p.includes('calls'));
    expect(edgeParams.length).toBeGreaterThan(0);
    expect(edgeParams.some((p) => p.map(String).includes('2'))).toBe(true);
  });
});

describe('rebuildTraceGraph no-op when source unavailable (T3 + allowEmpty sweep)', () => {
  it('returns {0,0}, never throws, and SWEEPS stale trace rows (allowEmpty) without touching flow/infra', async () => {
    const { pool, calls, params } = mockPool();
    const res = await rebuildTraceGraph(pool as never, new FakeTraceSource([], false), 'RUNT3');
    expect(res).toEqual({ nodes: 0, edges: 0 });
    // even with 0 nodes, the destructive sweep must run for class='trace'
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges') && s.includes('class = $1') && s.includes('run_id <> $2'))).toBe(true);
    expect(calls.some((s) => s.includes('DELETE FROM topology_nodes') && s.includes('class = $1') && s.includes('run_id <> $2'))).toBe(true);
    // class scope is trace only
    expect(params.some((p) => p.includes('trace'))).toBe(true);
    expect(params.some((p) => p.includes('flow') || p.includes('infra'))).toBe(false);
  });
});

describe('resolveInfraRef (bridge-ref matcher, pure)', () => {
  const infraNodes = [
    { id: 'rds:awsops-v2-aurora', kind: 'rds', meta: { host: 'awsops-v2-aurora.cluster-xyz.ap-northeast-2.rds.amazonaws.com' } },
    { id: 'ec2:i-1', kind: 'ec2', meta: { host: '10.0.0.1' } },
  ];

  it('matches a trace db host to the infra RDS node id (exact host)', () => {
    expect(resolveInfraRef('awsops-v2-aurora.cluster-xyz.ap-northeast-2.rds.amazonaws.com', infraNodes)).toBe('rds:awsops-v2-aurora');
    // case-insensitive exact
    expect(resolveInfraRef('AWSOPS-V2-AURORA.CLUSTER-XYZ.ap-northeast-2.rds.amazonaws.com', infraNodes)).toBe('rds:awsops-v2-aurora');
  });

  it('matches on the leading DNS label (cluster name) — a safe prefix, not arbitrary substring', () => {
    // trace host = first label of the infra host
    expect(resolveInfraRef('awsops-v2-aurora', infraNodes)).toBe('rds:awsops-v2-aurora');
  });

  it('does NOT false-match a short host as a mid-string substring (fix #2)', () => {
    const nodes = [{ id: 'rds:db', kind: 'rds', meta: { host: 'database.cluster-abc.rds.amazonaws.com' } }];
    // "db" is a substring of "database…" but is NOT the leading label → must NOT match
    expect(resolveInfraRef('db', nodes)).toBeUndefined();
    // a partial leading fragment that isn't a whole label boundary must NOT match either
    expect(resolveInfraRef('data', nodes)).toBeUndefined();
    // the real leading label does match
    expect(resolveInfraRef('database', nodes)).toBe('rds:db');
  });

  it('does NOT match when the infra host is a substring of the (longer) trace host', () => {
    const nodes = [{ id: 'rds:short', kind: 'rds', meta: { host: 'aurora' } }];
    // old bidirectional logic matched host.includes(nh); the tightened matcher must not
    expect(resolveInfraRef('aurora.cluster-xyz.rds.amazonaws.com', nodes)).toBeUndefined();
  });

  it('returns undefined for an unmatched host (node still emitted, no infra_ref)', () => {
    expect(resolveInfraRef('some-other-db.example.com', infraNodes)).toBeUndefined();
    expect(resolveInfraRef(undefined, infraNodes)).toBeUndefined();
    expect(resolveInfraRef('aurora', [])).toBeUndefined();
  });
});
