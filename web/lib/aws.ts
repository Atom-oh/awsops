import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

let eks: EKSClient | null = null;
let ce: CostExplorerClient | null = null;
function eksClient(): EKSClient { if (!eks) eks = new EKSClient({ region: REGION }); return eks; }
// Cost Explorer is a GLOBAL service reached via us-east-1 only.
function ceClient(): CostExplorerClient { if (!ce) ce = new CostExplorerClient({ region: 'us-east-1' }); return ce; }

export interface ClusterInfo {
  name: string; status: string; version: string; endpoint: string; createdAt: string;
  region: string; vpcId: string; platformVersion: string;
}

export async function listClusters(): Promise<ClusterInfo[]> {
  const c = eksClient();
  const { clusters = [] } = await c.send(new ListClustersCommand({}));
  const out: ClusterInfo[] = [];
  for (const name of clusters.slice(0, 25)) {
    const { cluster } = await c.send(new DescribeClusterCommand({ name }));
    out.push({
      name,
      status: cluster?.status ?? '?',
      version: cluster?.version ?? '?',
      endpoint: cluster?.endpoint ?? '',
      createdAt: cluster?.createdAt instanceof Date ? cluster.createdAt.toISOString() : '',
      region: REGION,
      vpcId: cluster?.resourcesVpcConfig?.vpcId ?? '',
      platformVersion: cluster?.platformVersion ?? '',
    });
  }
  return out;
}

export interface CostBreakdown { total: number; currency: string; byService: { service: string; amount: number }[] }

export async function getMtdCost(): Promise<CostBreakdown> {
  const now = new Date();
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow → start<end always, MTD-to-date
  const r = await ceClient().send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  const groups = r.ResultsByTime?.[0]?.Groups ?? [];
  const byService = groups
    .map((g) => ({ service: g.Keys?.[0] ?? '?', amount: Number(g.Metrics?.UnblendedCost?.Amount ?? 0) }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
  const currency = groups[0]?.Metrics?.UnblendedCost?.Unit ?? 'USD';
  const total = byService.reduce((s, x) => s + x.amount, 0);
  return { total, currency, byService };
}

export interface CostTrendPoint { date: string; amount: number }

/** Daily UnblendedCost for the trailing 30 days (no GroupBy) → [{ date, amount }] ascending. */
export async function getCostTrend(): Promise<CostTrendPoint[]> {
  const now = new Date();
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow → end is exclusive
  const start = new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10); // 30 days inclusive of today
  const r = await ceClient().send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
  }));
  return (r.ResultsByTime ?? []).map((t) => ({
    date: t.TimePeriod?.Start ?? '',
    amount: Number(t.Total?.UnblendedCost?.Amount ?? 0),
  }));
}

export interface MonthlyCostPoint { month: string; total: number }

/** Monthly UnblendedCost for the trailing `months` calendar months (incl. current MTD) → [{ month: 'YYYY-MM', total }] ascending. */
export async function getMonthlyCost(months = 6): Promise<MonthlyCostPoint[]> {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const start = startDate.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow → includes current partial month
  const r = await ceClient().send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  return (r.ResultsByTime ?? []).map((t) => ({
    month: (t.TimePeriod?.Start ?? '').slice(0, 7),
    total: (t.Groups ?? []).reduce((s, g) => s + Number(g.Metrics?.UnblendedCost?.Amount ?? 0), 0),
  }));
}

/** AWS-forecasted remaining UnblendedCost from tomorrow to month-end. null when there is no future window (last day). */
export async function getCostForecast(): Promise<number | null> {
  const now = new Date();
  const start = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // forecast start must be in the future
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); // 1st of next month (exclusive)
  if (start >= end) return null; // on/after the last day there is no remaining window to forecast
  const r = await ceClient().send(new GetCostForecastCommand({
    TimePeriod: { Start: start, End: end },
    Metric: 'UNBLENDED_COST',
    Granularity: 'MONTHLY',
  }));
  return Number(r.Total?.Amount ?? 0);
}
