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
}));

beforeEach(() => { eksSend.mockReset(); ceSend.mockReset(); });

describe('listClusters', () => {
  it('lists names then describes each', async () => {
    eksSend
      .mockResolvedValueOnce({ clusters: ['fsi-demo-cluster'] })
      .mockResolvedValueOnce({ cluster: { status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: new Date('2026-01-01T00:00:00Z') } });
    const { listClusters } = await import('./aws');
    const out = await listClusters();
    expect(out).toEqual([{ name: 'fsi-demo-cluster', status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: '2026-01-01T00:00:00.000Z' }]);
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
