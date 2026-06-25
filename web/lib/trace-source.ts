// web/lib/trace-source.ts
// Trace-level topology (class='trace') source abstraction (design: docs/superpowers/specs/
// 2026-06-25-trace-topology-design.md). A `TraceSource` decouples `rebuildTraceGraph` (graph-store.ts)
// from the trace backend. First adapter = ClickHouse otel (`otel_traces`); Datadog APM is a future
// adapter (interface only). The source is read-only and bounded; `available()` is false until the otel
// pipeline lands spans (the dormant "preparation" state — empty trace layer, no code change later).

import { getDatasource, getDefaultDatasource, resolveConnConfig } from '@/lib/datasources';
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';

/** One distributed-trace span, normalized across backends. Times are epoch-ms / duration-ms. */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  kind: string;
  dbSystem?: string;
  dbName?: string;
  dbHost?: string;
  peerService?: string;
  k8sNamespace?: string;
  k8sPod?: string;
  k8sDeployment?: string;
  startMs: number;
  durationMs: number;
}

/** Pluggable trace backend. `available()` gates the rebuild (false → empty, no-op layer). */
export interface TraceSource {
  available(): Promise<boolean>;
  /** Bounded fetch of recent spans: only the last `windowMins` minutes, at most `cap` rows. */
  recentSpans(windowMins: number, cap: number): Promise<TraceSpan[]>;
}

/** In-memory source for tests — seeded spans + an explicit availability flag. */
export class FakeTraceSource implements TraceSource {
  constructor(private readonly spans: TraceSpan[], private readonly isAvailable: boolean = true) {}
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async recentSpans(_windowMins: number, cap: number): Promise<TraceSpan[]> {
    return this.spans.slice(0, cap);
  }
}

// --- ClickHouse otel adapter -------------------------------------------------------------------

/** The OTel ClickHouse exporter's default `otel_traces` table. Attributes live in
 *  `Map(LowCardinality(String), String)` columns (`ResourceAttributes`, `SpanAttributes`), NOT flat
 *  columns; plus top-level `Timestamp`, `Duration` (ns), `TraceId`, `SpanId`, `ParentSpanId`,
 *  `ServiceName`, `SpanKind`. */
const OTEL_TRACES_TABLE = 'otel_traces';

interface OtelTracesRow {
  TraceId?: string;
  SpanId?: string;
  ParentSpanId?: string;
  ServiceName?: string;
  SpanKind?: string;
  Timestamp?: string; // ISO-ish or epoch; ClickHouse DateTime64
  Duration?: number | string; // nanoseconds
  ResourceAttributes?: Record<string, string>;
  SpanAttributes?: Record<string, string>;
}

/** Map one `otel_traces` row (real nested-map shape) → TraceSpan. Pure; exported for unit testing. */
export function mapOtelRow(row: OtelTracesRow): TraceSpan {
  const res = row.ResourceAttributes ?? {};
  const span = row.SpanAttributes ?? {};
  const service = row.ServiceName || res['service.name'] || 'unknown';
  const durationNs = Number(row.Duration ?? 0);
  const startMs = row.Timestamp ? new Date(row.Timestamp).getTime() : 0;
  const out: TraceSpan = {
    traceId: row.TraceId ?? '',
    spanId: row.SpanId ?? '',
    service,
    kind: row.SpanKind ?? '',
    startMs: Number.isFinite(startMs) ? startMs : 0,
    durationMs: Number.isFinite(durationNs) ? durationNs / 1e6 : 0,
  };
  if (row.ParentSpanId) out.parentSpanId = row.ParentSpanId;
  const dbSystem = span['db.system'];
  if (dbSystem) out.dbSystem = dbSystem;
  const dbName = span['db.name'];
  if (dbName) out.dbName = dbName;
  const dbHost = span['server.address'] || span['net.peer.name'] || span['db.connection_string'];
  if (dbHost) out.dbHost = dbHost;
  const peer = span['peer.service'];
  if (peer) out.peerService = peer;
  const ns = res['k8s.namespace.name'];
  if (ns) out.k8sNamespace = ns;
  const pod = res['k8s.pod.name'];
  if (pod) out.k8sPod = pod;
  const deploy = res['k8s.deployment.name'];
  if (deploy) out.k8sDeployment = deploy;
  return out;
}

/** Read-only adapter over the default ClickHouse datasource's `otel_traces` table. Reuses the existing
 *  connector path (`invokeMcpLambdaTool('clickhouse', 'clickhouse_query', …)`) so SSRF/credential reuse
 *  and the read-only SQL guard are inherited. `available()` is false when there is no default ClickHouse
 *  instance (the dormant pre-tracing state). */
export class ClickHouseOtelTraceSource implements TraceSource {
  constructor(private readonly instanceId?: number) {}

  private async resolve(): Promise<{ id: number; connConfig: Awaited<ReturnType<typeof resolveConnConfig>> } | null> {
    // Explicit-instance path: resolve the row by its integration id (must be a clickhouse instance).
    // Default path (no instanceId): the kind's default datasource — the dormant pre-tracing state has none.
    const row = this.instanceId
      ? await getDatasource(this.instanceId)
      : await getDefaultDatasource('clickhouse');
    if (!row || row.kind !== 'clickhouse') return null;
    const connConfig = await resolveConnConfig(row);
    return { id: row.id, connConfig };
  }

  async available(): Promise<boolean> {
    const r = await this.resolve();
    return r !== null;
  }

  async recentSpans(windowMins: number, cap: number): Promise<TraceSpan[]> {
    const r = await this.resolve();
    if (!r) return [];
    // Read-only SELECT, bounded by window + cap. Times: Timestamp DateTime64, Duration ns.
    const sql =
      `SELECT TraceId, SpanId, ParentSpanId, ServiceName, SpanKind, Timestamp, Duration, ` +
      `ResourceAttributes, SpanAttributes FROM ${OTEL_TRACES_TABLE} ` +
      `WHERE Timestamp >= now() - INTERVAL ${Math.max(1, Math.floor(windowMins))} MINUTE ` +
      `ORDER BY Timestamp DESC LIMIT ${Math.max(1, Math.floor(cap))}`;
    let result: unknown;
    try {
      result = await invokeMcpLambdaTool({
        kind: 'clickhouse',
        tool: 'clickhouse_query',
        args: { sql },
        connConfig: r.connConfig,
      });
    } catch {
      return []; // otel_traces absent / query failed → treat as no spans (dormant state, never throws)
    }
    const rows = extractRows(result);
    return rows.map(mapOtelRow);
  }
}

/** The connector returns a result envelope; pull out the row array tolerant of a few shapes. */
function extractRows(result: unknown): OtelTracesRow[] {
  if (Array.isArray(result)) return result as OtelTracesRow[];
  const r = result as { rows?: unknown; data?: unknown; result?: { rows?: unknown } } | null;
  if (r && Array.isArray(r.rows)) return r.rows as OtelTracesRow[];
  if (r && Array.isArray(r.data)) return r.data as OtelTracesRow[];
  if (r && r.result && Array.isArray(r.result.rows)) return r.result.rows as OtelTracesRow[];
  return [];
}
