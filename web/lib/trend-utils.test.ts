import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nearestSnapshot, netChange } from './trend-utils';

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T13:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('nearestSnapshot (±2 CALENDAR days, date-normalized)', () => {
  it('picks the closest point within tolerance; none within → null', () => {
    const pts = [{ date: day(9) }, { date: day(6) }, { date: day(0) }];
    expect(nearestSnapshot(pts, 7)?.date).toBe(day(6));
    expect(nearestSnapshot([{ date: day(12) }], 7)).toBeNull();
  });
  it('the window is symmetric in calendar days regardless of wall-clock time', () => {
    // a point 3 calendar days NEWER than the 7d target must not qualify even late in the day
    expect(nearestSnapshot([{ date: day(4) }, { date: day(12) }], 7)).toBeNull();
  });
});

describe('netChange honest-degrade branches (gap L127)', () => {
  it('STRICT type-set parity: a partial sync day (different type set) is null, never a partial diff', () => {
    const pts = [
      { date: day(7), total: 30, ec2: 10, s3: 20 },
      { date: day(0), total: 12, ec2: 12 }, // s3 snapshot missing today (mid-fan-out/failed)
    ];
    // raw total-diff would say -18; an intersection diff would say +2 — BOTH are sync
    // artifacts presented as fleet changes. Parity mismatch → null ('—').
    expect(netChange(pts, 7)).toBeNull();
  });
  it('equal type sets diff normally', () => {
    const pts = [
      { date: day(7), total: 30, ec2: 10, s3: 20 },
      { date: day(0), total: 35, ec2: 12, s3: 23 },
    ];
    expect(netChange(pts, 7)).toBe(5);
  });
  it('null when the baseline IS the latest point (stale sync self-diff would fabricate 0)', () => {
    // date-ascending: latest = day(6), which is also the only point within the 7d±2 window
    const pts = [{ date: day(20), total: 5, ec2: 5 }, { date: day(6), total: 7, ec2: 7 }];
    expect(netChange(pts, 7)).toBeNull();
    // input order is NOT assumed — the same points descending give the same answer
    expect(netChange([...pts].reverse(), 7)).toBeNull();
  });
  it('nearestSnapshot ties resolve toward the NEWER candidate (a 9-day span must not be labeled 7d)', () => {
    const pts = [{ date: day(9), total: 1 }, { date: day(5), total: 2 }];
    expect(nearestSnapshot(pts, 7)?.date).toBe(day(5));
  });
  it('null when the actual endpoint span is not ~7d (3-day diff must not be labeled 7d)', () => {
    // latest 2d old (passes the stale guard) + baseline 5d old (in the 7d±2 window) = 3-day span
    const pts = [{ date: day(5), total: 5, ec2: 5 }, { date: day(2), total: 7, ec2: 7 }];
    expect(netChange(pts, 7)).toBeNull();
    // a genuine ~7d span at the tolerance edges still diffs (8-day span: 1d-old vs 9d-old)
    const ok = [{ date: day(9), total: 5, ec2: 5 }, { date: day(1), total: 7, ec2: 7 }];
    expect(netChange(ok, 7)).toBe(2);
  });
  it('null when the latest snapshot itself is stale (>2 days old)', () => {
    const pts = [{ date: day(10), total: 5, ec2: 5 }, { date: day(5), total: 7, ec2: 7 }];
    expect(netChange(pts, 7)).toBeNull();
  });
  it('null with <2 points or no baseline in tolerance or zero shared type keys', () => {
    expect(netChange([{ date: day(0), total: 1, ec2: 1 }], 7)).toBeNull();
    expect(netChange([{ date: day(0), ec2: 1 }, { date: day(1), ec2: 2 }], 7)).toBeNull(); // no 7d baseline
    expect(netChange([{ date: day(7), s3: 1 }, { date: day(0), ec2: 2 }], 7)).toBeNull(); // disjoint types
  });
});

describe('netChange derived-series exclusion + account-coverage parity (gap L124/L129)', () => {
  it('derived security series never add to the net change (double-count guard)', () => {
    // +1 EBS volume that is also unencrypted: derived key moves in lockstep with the base key
    const pts = [
      { date: day(7), total: 10, ebs_volume: 10, unencrypted_ebs: 3 },
      { date: day(0), total: 11, ebs_volume: 11, unencrypted_ebs: 4 },
    ];
    expect(netChange(pts, 7)).toBe(1); // not 2
    // a bucket merely flipping to public is not a fleet change
    const flip = [
      { date: day(7), total: 5, s3: 5, public_s3_buckets: 0 },
      { date: day(0), total: 5, s3: 5, public_s3_buckets: 1 },
    ];
    expect(netChange(flip, 7)).toBe(0);
  });
  it('a derived-only fan-out difference does not fail type-set parity', () => {
    const pts = [
      { date: day(7), total: 10, ec2: 10 }, // pre-deploy day: no derived keys yet
      { date: day(0), total: 10, ec2: 10, unencrypted_ebs: 2 },
    ];
    expect(netChange(pts, 7)).toBe(0);
  });
  it('STRICT account-set parity: differing coverage between endpoint days is null', () => {
    const pts = [
      { date: day(7), total: 10, ec2: 10 },
      { date: day(0), total: 6, ec2: 6 },
    ];
    // an account silent on the latest day: its absence must not read as a fleet decrease
    expect(netChange(pts, 7, { [day(7)]: ['self', '222233334444'], [day(0)]: ['self'] })).toBeNull();
    // deploy boundary: baseline day is self-only, latest covers self+member → null, not growth
    expect(netChange(pts, 7, { [day(7)]: ['self'], [day(0)]: ['self', '222233334444'] })).toBeNull();
    // equal sets (order-insensitive) diff normally
    expect(netChange(pts, 7, { [day(7)]: ['222233334444', 'self'], [day(0)]: ['self', '222233334444'] })).toBe(-4);
    // provided-but-empty coverage is a mismatch, not a pass
    expect(netChange(pts, 7, {})).toBeNull();
    // no coverage arg (legacy caller) keeps the previous behavior
    expect(netChange(pts, 7)).toBe(-4);
  });
});
