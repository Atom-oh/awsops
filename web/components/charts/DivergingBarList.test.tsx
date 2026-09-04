// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DivergingBarList from './DivergingBarList';

const rows = [
  { label: 'EC2 Instances', value: 240, sub: '+3' },
  { label: 'NAT Gateways', value: -45, sub: '-1' },
  { label: 'Idle Type', value: 0 },
];

describe('DivergingBarList (dataviz polarity form)', () => {
  afterEach(cleanup);
  it('renders signed values with prefix/suffix and the sub figure', () => {
    render(<DivergingBarList title="t" rows={rows} valuePrefix="$" valueSuffix="/mo est." />);
    expect(screen.getByText('+$240/mo est.')).toBeTruthy();
    expect(screen.getByText('-$45/mo est.')).toBeTruthy();
    expect(screen.getByText('$0/mo est.')).toBeTruthy(); // zero: unsigned, no direction
    expect(screen.getByText('+3')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });

  it('scales symmetrically on max|value| and places bars on the correct pole', () => {
    const { container } = render(<DivergingBarList title="t" rows={rows} />);
    // positive bar sits in the RIGHT half-track (warm/negative status fill), width 100% (the max)
    const pos = container.querySelector('.bg-negative') as HTMLElement;
    expect(pos.style.width).toBe('100%');
    expect(pos.parentElement?.className).toContain('rounded-r-full');
    // negative bar sits in the LEFT half-track (positive/emerald fill), 45/240 of the shared scale
    const neg = container.querySelector('.bg-positive') as HTMLElement;
    expect(neg.style.width).toBe('18.75%'); // same scale both poles — equal magnitude = equal length
    expect(neg.parentElement?.className).toContain('rounded-l-full');
  });

  it('a zero row renders NO bar on either pole (no fabricated direction)', () => {
    const { container } = render(<DivergingBarList title="t" rows={[{ label: 'z', value: 0 }]} />);
    expect(container.querySelector('.bg-negative')).toBeNull();
    expect(container.querySelector('.bg-positive')).toBeNull();
  });

  it('sign colors follow polarity: increase = negative(warm) text, decrease = positive text', () => {
    render(<DivergingBarList title="t" rows={rows} />);
    expect(screen.getByText('+240').className).toContain('text-negative-text');
    expect(screen.getByText('-45').className).toContain('text-positive-text');
  });

  it('nonzero minimum visibility floor is 2%', () => {
    const { container } = render(
      <DivergingBarList title="t" rows={[{ label: 'big', value: 10_000 }, { label: 'tiny', value: 1 }]} />,
    );
    const fills = [...container.querySelectorAll('.bg-negative')] as HTMLElement[];
    expect(fills.map((f) => f.style.width)).toEqual(['100%', '2%']);
  });
});

describe('round-2 follow-ups', () => {
  it('a NON-FINITE value renders — with no bar on either pole (never a confident $0)', () => {
    const { container } = render(
      <DivergingBarList title="t" rows={[{ label: 'broken', value: Number.POSITIVE_INFINITY }, { label: 'ok', value: 10 }]} valuePrefix="$" />,
    );
    expect(screen.getByText('—')).toBeTruthy();
    // only the finite row draws a bar
    expect(container.querySelectorAll('.bg-negative')).toHaveLength(1);
    expect(screen.getByText('+$10')).toBeTruthy(); // scale unpolluted by the Infinity row
  });

  it('the value cell carries a title tooltip including the sub figure (mobile fallback)', () => {
    const { container } = render(
      <DivergingBarList title="t" rows={[{ label: 'EC2', value: 240, sub: '+3' }]} valuePrefix="$" />,
    );
    expect(container.querySelector('[title="EC2: +$240 (+3)"]')).toBeTruthy();
  });
});
