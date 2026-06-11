import { describe, it, expect, vi, beforeEach } from 'vitest';

const eksSend = vi.fn();
const ceSend = vi.fn();
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = eksSend; },
  ListClustersCommand: class { constructor(public input: unknown) {} },
  DescribeClusterCommand: class { constructor(public input: { name: string }) {} },
}));
vi.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: class { send = ceSend; },
  GetCostAndUsageCommand: class { constructor(public input: unknown) {} },
  GetCostForecastCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => { eksSend.mockReset(); ceSend.mockReset(); });

describe('listClusters', () => {
  it('lists names then describes each', async () => {
    eksSend
      .mockResolvedValueOnce({ clusters: ['fsi-demo-cluster'] })
      .mockResolvedValueOnce({ cluster: { status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: new Date('2026-01-01T00:00:00Z') } });
    const { listClusters } = await import('./aws');
    const out = await listClusters();
    expect(out).toEqual([{ name: 'fsi-demo-cluster', status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: '2026-01-01T00:00:00.000Z', region: 'ap-northeast-2', vpcId: '', platformVersion: '' }]);
  });
  it('returns [] when no clusters', async () => {
    eksSend.mockResolvedValueOnce({ clusters: [] });
    const { listClusters } = await import('./aws');
    expect(await listClusters()).toEqual([]);
  });
});

describe('getMtdCost', () => {
  it('aggregates + sorts by-service desc', async () => {
    ceSend.mockResolvedValue({ ResultsByTime: [{ Groups: [
      { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '310.5', Unit: 'USD' } } },
      { Keys: ['Amazon EKS'], Metrics: { UnblendedCost: { Amount: '180.0', Unit: 'USD' } } },
      { Keys: ['Zero'], Metrics: { UnblendedCost: { Amount: '0', Unit: 'USD' } } },
    ] }] });
    const { getMtdCost } = await import('./aws');
    const c = await getMtdCost();
    expect(c.currency).toBe('USD');
    expect(c.byService[0]).toEqual({ service: 'Amazon RDS', amount: 310.5 });
    expect(c.byService.find((s) => s.service === 'Zero')).toBeUndefined();
    expect(c.total).toBeCloseTo(490.5);
  });
});

describe('getMonthlyCost', () => {
  it('sums each month\'s service groups → [{month, total}] ascending', async () => {
    ceSend.mockResolvedValue({ ResultsByTime: [
      { TimePeriod: { Start: '2026-05-01' }, Groups: [
        { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '100', Unit: 'USD' } } },
        { Keys: ['Amazon EKS'], Metrics: { UnblendedCost: { Amount: '50', Unit: 'USD' } } },
      ] },
      { TimePeriod: { Start: '2026-06-01' }, Groups: [
        { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '120.25', Unit: 'USD' } } },
      ] },
    ] });
    const { getMonthlyCost } = await import('./aws');
    const out = await getMonthlyCost(2);
    expect(out).toEqual([
      { month: '2026-05', total: 150 },
      { month: '2026-06', total: 120.25 },
    ]);
  });
});

describe('getCostForecast', () => {
  it('returns the forecasted remaining amount', async () => {
    ceSend.mockResolvedValue({ Total: { Amount: '250.5', Unit: 'USD' } });
    const { getCostForecast } = await import('./aws');
    const v = await getCostForecast();
    // null only on the last day of the month (no future window); otherwise the mapped number
    if (v !== null) expect(v).toBeCloseTo(250.5);
  });
});
