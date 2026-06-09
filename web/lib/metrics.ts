import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';

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
