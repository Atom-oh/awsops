import { describe, it, expect, vi, beforeEach } from 'vitest';

const cwSend = vi.fn();
const priceSend = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = cwSend; },
  GetMetricDataCommand: class { constructor(public input: unknown) {} },
  ListMetricsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-pricing', () => ({
  PricingClient: class { send = priceSend; },
  GetProductsCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => { cwSend.mockReset(); priceSend.mockReset(); });

// A realistic Pricing API PriceList entry (stringified JSON) → on-demand $/hr.
const priceList = (usd: string) => JSON.stringify({
  product: { attributes: { instanceType: 't3.micro' } },
  terms: {
    OnDemand: {
      'ABC.JRTCKXETXF': {
        priceDimensions: {
          'ABC.JRTCKXETXF.6YS6EN2CT7': {
            unit: 'Hrs',
            pricePerUnit: { USD: usd },
          },
        },
      },
    },
  },
});

describe('ec2AvgCpu', () => {
  it('averages the latest datapoint across results, rounded to 0.1', async () => {
    cwSend.mockResolvedValueOnce({
      MetricDataResults: [
        { Id: 'm0', Values: [10.2, 5] },
        { Id: 'm1', Values: [20.6, 9] },
      ],
    });
    const { ec2AvgCpu } = await import('./metrics');
    // (10.2 + 20.6) / 2 = 15.4
    expect(await ec2AvgCpu(['i-aaa', 'i-bbb'])).toBe(15.4);
  });

  it('returns null for empty ids (no CloudWatch call)', async () => {
    const { ec2AvgCpu } = await import('./metrics');
    expect(await ec2AvgCpu([])).toBeNull();
    expect(cwSend).not.toHaveBeenCalled();
  });

  it('returns null when no datapoints', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [{ Id: 'm0', Values: [] }] });
    const { ec2AvgCpu } = await import('./metrics');
    expect(await ec2AvgCpu(['i-aaa'])).toBeNull();
  });
});

describe('ec2HourlyCost', () => {
  it('parses Pricing on-demand USD and sums price × count', async () => {
    priceSend
      .mockResolvedValueOnce({ PriceList: [priceList('0.0130')] }) // t3.micro
      .mockResolvedValueOnce({ PriceList: [priceList('0.0084')] }); // t4g.nano
    const { ec2HourlyCost } = await import('./metrics');
    // 0.0130*2 + 0.0084*1 = 0.0344 → round(*100)/100 = 0.03
    expect(await ec2HourlyCost({ 't3.micro': 2, 't4g.nano': 1 })).toBe(0.03);
    expect(priceSend).toHaveBeenCalledTimes(2);
  });

  it('caches per instance type (second call hits cache, no extra send)', async () => {
    priceSend.mockResolvedValueOnce({ PriceList: [priceList('1.00')] });
    const { ec2HourlyCost } = await import('./metrics');
    expect(await ec2HourlyCost({ 'cached.type': 3 })).toBe(3);
    expect(await ec2HourlyCost({ 'cached.type': 5 })).toBe(5);
    expect(priceSend).toHaveBeenCalledTimes(1); // cached on 2nd call
  });

  it('returns null when no type priced (empty PriceList / throw degrade)', async () => {
    priceSend.mockResolvedValueOnce({ PriceList: [] });
    const { ec2HourlyCost } = await import('./metrics');
    expect(await ec2HourlyCost({ 'unpriced.type': 4 })).toBeNull();
  });
});

describe('bedrockModelMetrics', () => {
  it('discovers models via ListMetrics then aggregates + prices GetMetricData', async () => {
    cwSend
      // Step 1: ListMetrics → one model dimension
      .mockResolvedValueOnce({ Metrics: [{ Dimensions: [{ Name: 'ModelId', Value: 'anthropic.claude-haiku-4-5' }] }] })
      // Step 2: GetMetricData → 8 metric results for m0
      .mockResolvedValueOnce({ MetricDataResults: [
        { Id: 'inv_m0', Values: [10, 5], Timestamps: ['2026-06-10T00:00:00Z', '2026-06-10T01:00:00Z'] },
        { Id: 'in_m0', Values: [600_000, 400_000], Timestamps: ['2026-06-10T00:00:00Z', '2026-06-10T01:00:00Z'] },
        { Id: 'out_m0', Values: [2_000_000], Timestamps: ['2026-06-10T00:00:00Z'] },
        { Id: 'lat_m0', Values: [120, 80] },
        { Id: 'e4_m0', Values: [1] },
        { Id: 'e5_m0', Values: [] },
        { Id: 'cr_m0', Values: [1_000_000] },
        { Id: 'cw_m0', Values: [0] },
      ] });
    const { bedrockModelMetrics } = await import('./metrics');
    const r = await bedrockModelMetrics('24h');
    expect(r.models).toHaveLength(1);
    const m = r.models[0];
    expect(m.label).toBe('Claude Haiku 4.5');
    expect(m.invocations).toBe(15);
    expect(m.inputTokens).toBe(1_000_000);
    expect(m.outputTokens).toBe(2_000_000);
    expect(m.avgLatencyMs).toBe(100); // (120+80)/2
    expect(m.cacheReadTokens).toBe(1_000_000);
    // haiku-4.5: input 1, output 5, cacheRead .1 → 1 + 10 + 0.1 = 11.1
    expect(m.cost.total).toBeCloseTo(11.1);
    expect(r.totalCost).toBeCloseTo(11.1);
    // combined token series sums input+output per timestamp
    expect(r.series.find((s) => s.t === '2026-06-10T00:00:00Z')?.tokens).toBe(2_600_000);
  });

  it('returns empty when ListMetrics finds no models (no GetMetricData call)', async () => {
    cwSend.mockResolvedValueOnce({ Metrics: [] });
    const { bedrockModelMetrics } = await import('./metrics');
    const r = await bedrockModelMetrics('1h');
    expect(r).toEqual({ models: [], totalCost: 0, series: [] });
    expect(cwSend).toHaveBeenCalledTimes(1); // only ListMetrics
  });
});
