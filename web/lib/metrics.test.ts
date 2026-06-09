import { describe, it, expect, vi, beforeEach } from 'vitest';

const cwSend = vi.fn();
const priceSend = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = cwSend; },
  GetMetricDataCommand: class { constructor(public input: unknown) {} },
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
