import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDefaultDatasource = vi.fn();
const getDatasource = vi.fn();
const resolveConnConfig = vi.fn();
const invokeMcpLambdaTool = vi.fn();
vi.mock('@/lib/datasources', () => ({
  getDefaultDatasource: (...a: unknown[]) => getDefaultDatasource(...a),
  getDatasource: (...a: unknown[]) => getDatasource(...a),
  resolveConnConfig: (...a: unknown[]) => resolveConnConfig(...a),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({
  invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a),
}));

import {
  FakeTraceSource,
  ClickHouseOtelTraceSource,
  mapOtelRow,
  type TraceSpan,
} from './trace-source';

const span = (over: Partial<TraceSpan> = {}): TraceSpan => ({
  traceId: 't1', spanId: 's1', service: 'svc', kind: 'SERVER', startMs: 0, durationMs: 1, ...over,
});

describe('FakeTraceSource (TraceSource contract)', () => {
  it('reports its availability flag and returns seeded spans up to cap', async () => {
    const spans = [span({ spanId: 'a' }), span({ spanId: 'b' }), span({ spanId: 'c' })];
    const src = new FakeTraceSource(spans, true);
    expect(await src.available()).toBe(true);
    expect(await src.recentSpans(60, 2)).toHaveLength(2);
    expect(await src.recentSpans(60, 99)).toHaveLength(3);
  });

  it('available() false when constructed unavailable', async () => {
    const src = new FakeTraceSource([], false);
    expect(await src.available()).toBe(false);
  });
});

describe('mapOtelRow (real nested-map otel_traces shape)', () => {
  it('extracts service / db / k8s from the Map columns + top-level fields', () => {
    const row = {
      TraceId: 'abc', SpanId: 'def', ParentSpanId: 'par',
      ServiceName: 'checkout', SpanKind: 'SPAN_KIND_CLIENT',
      Timestamp: '2026-06-25T00:00:00.000Z',
      Duration: 5_000_000, // 5ms in ns
      ResourceAttributes: {
        'service.name': 'checkout',
        'k8s.namespace.name': 'shop', 'k8s.pod.name': 'checkout-xyz', 'k8s.deployment.name': 'checkout',
      },
      SpanAttributes: { 'db.system': 'postgresql', 'db.name': 'orders', 'server.address': 'aurora.example.rds' },
    };
    const s = mapOtelRow(row);
    expect(s).toMatchObject({
      traceId: 'abc', spanId: 'def', parentSpanId: 'par', service: 'checkout',
      dbSystem: 'postgresql', dbName: 'orders', dbHost: 'aurora.example.rds',
      k8sNamespace: 'shop', k8sPod: 'checkout-xyz', k8sDeployment: 'checkout',
      durationMs: 5,
    });
    expect(s.startMs).toBe(Date.parse('2026-06-25T00:00:00.000Z'));
  });

  it('falls back to ResourceAttributes service.name and omits absent attrs', () => {
    const s = mapOtelRow({ ResourceAttributes: { 'service.name': 'edge' }, SpanAttributes: {} });
    expect(s.service).toBe('edge');
    expect(s.dbSystem).toBeUndefined();
    expect(s.k8sNamespace).toBeUndefined();
    expect(s.parentSpanId).toBeUndefined();
  });
});

describe('ClickHouseOtelTraceSource', () => {
  beforeEach(() => {
    getDefaultDatasource.mockReset(); getDatasource.mockReset(); resolveConnConfig.mockReset(); invokeMcpLambdaTool.mockReset();
  });

  it('available() false when there is no default clickhouse instance', async () => {
    getDefaultDatasource.mockResolvedValue(null);
    expect(await new ClickHouseOtelTraceSource().available()).toBe(false);
  });

  it('available() true when a default clickhouse instance resolves', async () => {
    getDefaultDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch' });
    expect(await new ClickHouseOtelTraceSource().available()).toBe(true);
  });

  it('recentSpans runs a read-only SELECT against otel_traces and maps rows', async () => {
    getDefaultDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch' });
    invokeMcpLambdaTool.mockResolvedValue({
      rows: [{ ServiceName: 'a', SpanAttributes: {}, ResourceAttributes: {} }],
    });
    const out = await new ClickHouseOtelTraceSource().recentSpans(30, 100);
    expect(out).toHaveLength(1);
    expect(out[0].service).toBe('a');
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(call.kind).toBe('clickhouse');
    expect(call.tool).toBe('clickhouse_query');
    expect(String(call.args.sql)).toMatch(/SELECT[\s\S]*otel_traces/);
    expect(String(call.args.sql)).toMatch(/LIMIT 100/);
  });

  it('recentSpans returns [] (no throw) when the query fails (otel_traces absent)', async () => {
    getDefaultDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch' });
    invokeMcpLambdaTool.mockRejectedValue(new Error('UNKNOWN_TABLE'));
    expect(await new ClickHouseOtelTraceSource().recentSpans(30, 100)).toEqual([]);
  });

  it('explicit instanceId resolves the row by id (not the kind default)', async () => {
    getDatasource.mockResolvedValue({ id: 42, kind: 'clickhouse', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch-42' });
    expect(await new ClickHouseOtelTraceSource(42).available()).toBe(true);
    expect(getDatasource).toHaveBeenCalledWith(42);
    expect(getDefaultDatasource).not.toHaveBeenCalled();
  });

  it('explicit instanceId → false when the id is missing or not a clickhouse instance', async () => {
    getDatasource.mockResolvedValueOnce(null);
    expect(await new ClickHouseOtelTraceSource(99).available()).toBe(false);
    getDatasource.mockResolvedValueOnce({ id: 5, kind: 'prometheus', isDefault: false });
    expect(await new ClickHouseOtelTraceSource(5).available()).toBe(false);
  });
});
