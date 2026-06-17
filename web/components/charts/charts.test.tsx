// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// recharts ResponsiveContainer measures its parent, which jsdom reports as 0×0
// so chart children never mount. Replace it with a fixed-size div so the inner
// chart renders deterministically. Keep assertions shallow (title + no throw).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 240 }}>{children}</div>
    ),
  };
});

import AreaTrend from './AreaTrend';
import BarDistribution from './BarDistribution';
import DonutBreakdown from './DonutBreakdown';
import HBarList from './HBarList';

afterEach(cleanup);

const trend = [
  { date: '2026-06-01', amount: 120.5 },
  { date: '2026-06-02', amount: 98.2 },
  { date: '2026-06-03', amount: 143.7 },
];
const dist = [
  { label: 'EC2', count: 25 },
  { label: 'Lambda', count: 12 },
  { label: 'S3', count: 8 },
];
const cats = [
  { group: 'compute', count: 40 },
  { group: 'storage', count: 18 },
  { group: 'network', count: 9 },
];
const services = [
  { service: 'Amazon EC2', amount: 3200.4 },
  { service: 'Amazon RDS', amount: 1450.0 },
  { service: 'Amazon S3', amount: 620.75 },
];

describe('AreaTrend', () => {
  it('renders its title without throwing', () => {
    expect(() =>
      render(<AreaTrend title="일별 비용 추이" data={trend} xKey="date" yKey="amount" valuePrefix="$" />),
    ).not.toThrow();
    expect(screen.getByText('일별 비용 추이')).toBeTruthy();
  });
});

describe('BarDistribution', () => {
  it('renders its title without throwing', () => {
    expect(() =>
      render(<BarDistribution title="리소스 분포" data={dist} xKey="label" yKey="count" />),
    ).not.toThrow();
    expect(screen.getByText('리소스 분포')).toBeTruthy();
  });
});

describe('DonutBreakdown', () => {
  it('renders its title, a legend entry, and the total without throwing', () => {
    expect(() =>
      render(<DonutBreakdown title="카테고리별 리소스" data={cats} nameKey="group" valueKey="count" />),
    ).not.toThrow();
    expect(screen.getByText('카테고리별 리소스')).toBeTruthy();
    expect(screen.getByText('compute')).toBeTruthy();
    // center total = 40 + 18 + 9 = 67
    expect(screen.getByText('67')).toBeTruthy();
  });
});

describe('HBarList', () => {
  it('renders its title and a labelled row with a $ amount without throwing', () => {
    expect(() =>
      render(
        <HBarList
          title="서비스별 비용"
          data={services}
          labelKey="service"
          valueKey="amount"
          valuePrefix="$"
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText('서비스별 비용')).toBeTruthy();
    expect(screen.getByText('Amazon EC2')).toBeTruthy();
    expect(screen.getByText('$3,200.40')).toBeTruthy();
  });
});
