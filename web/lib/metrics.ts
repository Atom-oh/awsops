import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { getModelLabel, getModelPricing, computeCost, RANGE_CONFIGS, type ModelPricing, type CostBreakdown } from './bedrock';
import { assumedClient } from './aws-assume';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

let cw: CloudWatchClient | null = null;
const cwClient = () => (cw ??= new CloudWatchClient({ region: REGION }));

/** Fleet average of the latest 1h CPUUtilization across up to 100 instances. null when no datapoints. */
export async function ec2AvgCpu(instanceIds: string[]): Promise<number | null> {
  const ids = instanceIds.slice(0, 100);
  if (!ids.length) return null;
  const r = await cwClient().send(new GetMetricDataCommand({
    StartTime: new Date(Date.now() - 3 * 3600_000), EndTime: new Date(),
    MetricDataQueries: ids.map((id, i) => ({
      Id: `m${i}`, ReturnData: true,
      MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: id }] }, Period: 3600, Stat: 'Average' },
    })),
  }));
  const latest = (r.MetricDataResults ?? []).map((m) => m.Values?.[0]).filter((v): v is number => typeof v === 'number');
  if (!latest.length) return null;
  return Math.round((latest.reduce((a, b) => a + b, 0) / latest.length) * 10) / 10;
}

// ── RDS per-instance CloudWatch metrics (v1 parity) ─────────────────────────
export interface RdsInstanceMetrics {
  cpu: number | null;            // CPUUtilization (%)
  freeableMemory: number | null; // bytes
  connections: number | null;    // DatabaseConnections (count)
  readIops: number | null;       // ReadIOPS (ops/s)
  writeIops: number | null;      // WriteIOPS (ops/s)
  freeStorage: number | null;    // FreeStorageSpace (bytes)
  netIn: number | null;          // NetworkReceiveThroughput (bytes/s)
  netOut: number | null;         // NetworkTransmitThroughput (bytes/s)
}
export interface RdsMetrics {
  byInstance: Record<string, RdsInstanceMetrics>;
  avgCpu: number | null; // fleet average CPU across instances reporting a datapoint
}

const RDS_METRICS = [
  { key: 'cpu', field: 'cpu', name: 'CPUUtilization' },
  { key: 'mem', field: 'freeableMemory', name: 'FreeableMemory' },
  { key: 'conn', field: 'connections', name: 'DatabaseConnections' },
  { key: 'rio', field: 'readIops', name: 'ReadIOPS' },
  { key: 'wio', field: 'writeIops', name: 'WriteIOPS' },
  { key: 'storage', field: 'freeStorage', name: 'FreeStorageSpace' },
  { key: 'netin', field: 'netIn', name: 'NetworkReceiveThroughput' },
  { key: 'netout', field: 'netOut', name: 'NetworkTransmitThroughput' },
] as const;

const emptyRds = (): RdsInstanceMetrics => ({
  cpu: null, freeableMemory: null, connections: null, readIops: null,
  writeIops: null, freeStorage: null, netIn: null, netOut: null,
});

/**
 * Per-instance RDS CloudWatch metrics — the 8 series v1 rendered (latest 1h Average over a ~3h window).
 * Read-only, live-fetch (not persisted), multi-account via `assumedClient` (host/self → task-role creds).
 * Batches ≤62 instances per GetMetricData call (8 metrics × 62 = 496 < the 500 query/call cap — no silent
 * truncation). Degrades to an empty result on any CloudWatch error (never throws).
 */
export async function rdsMetrics(instanceIds: string[], accountId?: string): Promise<RdsMetrics> {
  const ids = instanceIds; // no silent cap — the 62/call chunk loop below covers any fleet size
  if (!ids.length) return { byInstance: {}, avgCpu: null };
  const byInstance: Record<string, RdsInstanceMetrics> = {};
  try {
    const client = await assumedClient(accountId, CloudWatchClient, { region: REGION });
    const CHUNK = 62; // 8 metrics × 62 = 496 ≤ 500 GetMetricData queries/call
    for (let c = 0; c < ids.length; c += CHUNK) {
      const chunk = ids.slice(c, c + CHUNK);
      for (const id of chunk) byInstance[id] ??= emptyRds();
      const queries = chunk.flatMap((id, i) =>
        RDS_METRICS.map((m) => ({
          Id: `${m.key}_i${i}`, ReturnData: true,
          MetricStat: { Metric: { Namespace: 'AWS/RDS', MetricName: m.name, Dimensions: [{ Name: 'DBInstanceIdentifier', Value: id }] }, Period: 3600, Stat: 'Average' },
        })),
      );
      const r = await client.send(new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 3 * 3600_000), EndTime: new Date(),
        MetricDataQueries: queries,
      }));
      for (const res of r.MetricDataResults ?? []) {
        const mm = (res.Id ?? '').match(/^(\w+?)_i(\d+)$/);
        if (!mm) continue;
        const def = RDS_METRICS.find((m) => m.key === mm[1]);
        const id = chunk[Number(mm[2])];
        const v = res.Values?.[0];
        if (def && id && typeof v === 'number') {
          (byInstance[id] as unknown as Record<string, number | null>)[def.field] = Math.round(v * 100) / 100;
        }
      }
    }
  } catch {
    return { byInstance: {}, avgCpu: null };
  }
  const cpus = Object.values(byInstance).map((m) => m.cpu).filter((v): v is number => typeof v === 'number');
  const avgCpu = cpus.length ? Math.round((cpus.reduce((a, b) => a + b, 0) / cpus.length) * 10) / 10 : null;
  return { byInstance, avgCpu };
}

let pricing: PricingClient | null = null;
// Pricing API is reached via us-east-1 only.
const priceClient = () => (pricing ??= new PricingClient({ region: 'us-east-1' }));
const priceCache = new Map<string, number | null>();

async function onDemandHourly(instanceType: string): Promise<number | null> {
  if (priceCache.has(instanceType)) return priceCache.get(instanceType)!;
  let price: number | null = null;
  try {
    const r = await priceClient().send(new GetProductsCommand({
      ServiceCode: 'AmazonEC2', MaxResults: 1,
      Filters: [
        { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
        { Type: 'TERM_MATCH', Field: 'location', Value: 'Asia Pacific (Seoul)' },
        { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
        { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
        { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
        { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
      ],
    }));
    const item = r.PriceList?.[0];
    if (item) {
      const p = JSON.parse(item as string);
      const od = p.terms?.OnDemand ?? {};
      const dim = Object.values(od)[0] as any;
      const pd = dim && Object.values(dim.priceDimensions ?? {})[0] as any;
      const usd = pd?.pricePerUnit?.USD;
      if (usd) price = Number(usd);
    }
  } catch { price = null; }
  priceCache.set(instanceType, price);
  return price;
}

/** Sum of on-demand hourly $/hr × count across instance types. null when no type priced. */
export async function ec2HourlyCost(typeCounts: Record<string, number>): Promise<number | null> {
  let total = 0, any = false;
  for (const [t, n] of Object.entries(typeCounts)) {
    const p = await onDemandHourly(t);
    if (p != null) { total += p * n; any = true; }
  }
  return any ? Math.round(total * 100) / 100 : null;
}

// ── Bedrock model usage metrics (AWS/Bedrock CloudWatch) ────────────────────
export interface BedrockModelMetric {
  modelId: string; label: string; pricing: ModelPricing;
  invocations: number; inputTokens: number; outputTokens: number;
  avgLatencyMs: number; clientErrors: number; serverErrors: number;
  cacheReadTokens: number; cacheWriteTokens: number;
  cost: CostBreakdown;
}
export interface BedrockMetrics {
  models: BedrockModelMetric[];
  totalCost: number;
  series: { t: string; tokens: number }[]; // combined input+output tokens over time
}

const BEDROCK_METRICS = [
  { id: 'inv', name: 'Invocations', stat: 'Sum' },
  { id: 'in', name: 'InputTokenCount', stat: 'Sum' },
  { id: 'out', name: 'OutputTokenCount', stat: 'Sum' },
  { id: 'lat', name: 'InvocationLatency', stat: 'Average' },
  { id: 'e4', name: 'InvocationClientErrors', stat: 'Sum' },
  { id: 'e5', name: 'InvocationServerErrors', stat: 'Sum' },
  { id: 'cr', name: 'CacheReadInputTokenCount', stat: 'Sum' },
  { id: 'cw', name: 'CacheWriteInputTokenCount', stat: 'Sum' },
] as const;

const sum = (v?: number[]) => (v ?? []).reduce((s, x) => s + x, 0);
const avg = (v?: number[]) => (v && v.length ? sum(v) / v.length : 0);

/**
 * Per-model Bedrock usage over the given range.
 * Step 1: ListMetrics(AWS/Bedrock, Invocations) → enumerate the ModelId dimension values
 *         (GetMetricData alone can't enumerate dimension values).
 * Step 2: GetMetricData for the 8 metrics × each model; aggregate + price.
 */
export async function bedrockModelMetrics(range = '24h', accountId?: string): Promise<BedrockMetrics> {
  const cfg = RANGE_CONFIGS[range] ?? RANGE_CONFIGS['24h'];
  // account-scoped CloudWatch client: host (null/self) → task-role creds; target → assumed read-only role.
  const cw = await assumedClient(accountId, CloudWatchClient, { region: REGION });
  const lm = await cw.send(new ListMetricsCommand({ Namespace: 'AWS/Bedrock', MetricName: 'Invocations' }));
  const ids = new Set<string>();
  for (const m of lm.Metrics ?? []) {
    for (const d of m.Dimensions ?? []) if (d.Name === 'ModelId' && d.Value) ids.add(d.Value);
  }
  const models = [...ids];
  if (!models.length) return { models: [], totalCost: 0, series: [] };

  const queries = models.flatMap((id, mi) =>
    BEDROCK_METRICS.map((d) => ({
      Id: `${d.id}_m${mi}`, ReturnData: true,
      MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: d.name, Dimensions: [{ Name: 'ModelId', Value: id }] }, Period: cfg.period, Stat: d.stat },
    })),
  );
  // CloudWatch caps GetMetricData at 500 queries/call. Warn rather than silently truncate
  // (would only bite at >62 active models — well beyond reality, but no silent caps).
  if (queries.length > 500) {
    console.warn(`[bedrock] ${models.length} models × ${BEDROCK_METRICS.length} metrics = ${queries.length} queries > 500 cap; metrics truncated`);
  }
  const r = await cw.send(new GetMetricDataCommand({
    StartTime: new Date(Date.now() - cfg.hours * 3600_000), EndTime: new Date(),
    MetricDataQueries: queries.slice(0, 500),
  }));

  const acc: Record<number, { inv: number[]; in: number[]; out: number[]; lat: number[]; e4: number[]; e5: number[]; cr: number[]; cw: number[] }> = {};
  const seriesByTs = new Map<string, number>();
  for (const res of r.MetricDataResults ?? []) {
    const m = (res.Id ?? '').match(/^(\w+?)_m(\d+)$/);
    if (!m) continue;
    const key = m[1] as keyof (typeof acc)[number];
    const mi = Number(m[2]);
    if (mi >= models.length) continue;
    (acc[mi] ??= { inv: [], in: [], out: [], lat: [], e4: [], e5: [], cr: [], cw: [] })[key] = (res.Values ?? []) as number[];
    // combined token time series (input + output) keyed by timestamp
    if (key === 'in' || key === 'out') {
      const ts = res.Timestamps ?? [];
      const vals = res.Values ?? [];
      ts.forEach((t, i) => {
        const iso = t instanceof Date ? t.toISOString() : String(t);
        seriesByTs.set(iso, (seriesByTs.get(iso) ?? 0) + (vals[i] ?? 0));
      });
    }
  }

  const out: BedrockModelMetric[] = models.map((modelId, mi) => {
    const a = acc[mi] ?? { inv: [], in: [], out: [], lat: [], e4: [], e5: [], cr: [], cw: [] };
    const pricing = getModelPricing(modelId);
    const usage = { inputTokens: sum(a.in), outputTokens: sum(a.out), cacheReadTokens: sum(a.cr), cacheWriteTokens: sum(a.cw) };
    return {
      modelId, label: getModelLabel(modelId), pricing,
      invocations: sum(a.inv), ...usage,
      avgLatencyMs: Math.round(avg(a.lat)),
      clientErrors: sum(a.e4), serverErrors: sum(a.e5),
      cost: computeCost(usage, pricing),
    };
  });
  out.sort((x, y) => y.cost.total - x.cost.total);
  const totalCost = out.reduce((s, m) => s + m.cost.total, 0);
  const series = [...seriesByTs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, tokens]) => ({ t, tokens }));
  return { models: out, totalCost, series };
}

// ── Generic per-resource live CloudWatch metrics (v1 parity for ElastiCache/OpenSearch/MSK) ──
// One GetMetricData call per resource; every failure degrades to [] (never blanks the panel).
export interface LiveMetric { label: string; value: string }

type LiveFmt = 'pct' | 'gb' | 'mb' | 'count' | 'ms' | 'bps';
interface LiveMetricDef { name: string; label: string; stat: 'Average' | 'Sum' | 'Maximum'; fmt: LiveFmt }
interface LiveMetricSpec { namespace: string; dims: (id: string) => { Name: string; Value: string }[]; metrics: LiveMetricDef[] }

const LIVE_SPECS: Record<string, LiveMetricSpec> = {
  // resource_id = CacheClusterId
  elasticache: {
    namespace: 'AWS/ElastiCache',
    dims: (id) => [{ Name: 'CacheClusterId', Value: id }],
    metrics: [
      { name: 'CPUUtilization', label: 'CPU', stat: 'Average', fmt: 'pct' },
      { name: 'EngineCPUUtilization', label: 'Engine CPU', stat: 'Average', fmt: 'pct' },
      { name: 'FreeableMemory', label: 'Freeable Memory', stat: 'Average', fmt: 'gb' },
      { name: 'NetworkBytesIn', label: 'Network In', stat: 'Average', fmt: 'mb' },
      { name: 'NetworkBytesOut', label: 'Network Out', stat: 'Average', fmt: 'mb' },
      { name: 'CurrConnections', label: 'Connections', stat: 'Average', fmt: 'count' },
    ],
  },
  // resource_id = DomainName. AWS/ES requires the ClientId (account) dimension.
  opensearch: {
    namespace: 'AWS/ES',
    dims: (id) => [
      { Name: 'DomainName', Value: id },
      { Name: 'ClientId', Value: process.env.AWS_ACCOUNT_ID ?? '' },
    ],
    metrics: [
      { name: 'CPUUtilization', label: 'CPU', stat: 'Average', fmt: 'pct' },
      { name: 'JVMMemoryPressure', label: 'JVM Memory', stat: 'Average', fmt: 'pct' },
      { name: 'FreeStorageSpace', label: 'Free Storage', stat: 'Average', fmt: 'mb' },
      { name: 'SearchableDocuments', label: 'Documents', stat: 'Average', fmt: 'count' },
      { name: 'SearchLatency', label: 'Search Latency', stat: 'Average', fmt: 'ms' },
      { name: 'IndexingLatency', label: 'Indexing Latency', stat: 'Average', fmt: 'ms' },
      { name: 'ClusterStatus.yellow', label: 'Status Yellow', stat: 'Maximum', fmt: 'count' },
      { name: 'ClusterStatus.red', label: 'Status Red', stat: 'Maximum', fmt: 'count' },
    ],
  },
  // resource_id = cluster name (sync primary key). Cluster-level dimensions only.
  msk: {
    namespace: 'AWS/Kafka',
    dims: (id) => [{ Name: 'Cluster Name', Value: id }],
    metrics: [
      { name: 'ActiveControllerCount', label: 'Active Controllers', stat: 'Maximum', fmt: 'count' },
      { name: 'OfflinePartitionsCount', label: 'Offline Partitions', stat: 'Maximum', fmt: 'count' },
      { name: 'GlobalTopicCount', label: 'Topics', stat: 'Maximum', fmt: 'count' },
      { name: 'GlobalPartitionCount', label: 'Partitions', stat: 'Maximum', fmt: 'count' },
    ],
  },
};

function fmtLive(v: number, fmt: LiveFmt): string {
  switch (fmt) {
    case 'pct': return `${Math.round(v * 10) / 10}%`;
    case 'gb': return `${(v / 1e9).toFixed(1)} GB`;
    case 'mb': return `${(v / 1e6).toFixed(1)} MB`;
    case 'ms': return `${Math.round(v * 1000) / 1000} ms`;
    case 'bps': return `${(v / 1e6).toFixed(1)} MB/s`;
    default: return Math.round(v).toLocaleString();
  }
}

export function hasLiveMetrics(type: string): boolean { return type in LIVE_SPECS; }

/** Latest-hour metrics for ONE resource of a LIVE_SPECS type. [] on error/no data. */
export async function liveResourceMetrics(type: string, id: string, accountId?: string): Promise<LiveMetric[]> {
  const spec = LIVE_SPECS[type];
  if (!spec) return [];
  try {
    const client = await assumedClient(accountId, CloudWatchClient, { region: REGION });
    const r = await client.send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - 3 * 3600_000), EndTime: new Date(),
      MetricDataQueries: spec.metrics.map((m, i) => ({
        Id: `lm${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: spec.namespace, MetricName: m.name, Dimensions: spec.dims(id) }, Period: 3600, Stat: m.stat },
      })),
    }));
    const out: LiveMetric[] = [];
    for (const res of r.MetricDataResults ?? []) {
      const i = Number((res.Id ?? '').replace('lm', ''));
      const def = spec.metrics[i];
      const v = res.Values?.[0];
      if (def) out.push({ label: def.label, value: typeof v === 'number' ? fmtLive(v, def.fmt) : '—' });
    }
    return out;
  } catch {
    return [];
  }
}
