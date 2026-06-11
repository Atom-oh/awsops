import { describe, it, expect } from 'vitest';
import { parseCpuCores, parseMem, aggregateNodeResources, type NodeRow, type PodRow } from './eks-resources';

describe('parseCpuCores', () => {
  it('parses whole cores and millicores', () => {
    expect(parseCpuCores('8')).toBe(8);
    expect(parseCpuCores('7910m')).toBeCloseTo(7.91);
    expect(parseCpuCores('250m')).toBeCloseTo(0.25);
  });
  it('returns 0 for empty/null/garbage', () => {
    expect(parseCpuCores('')).toBe(0);
    expect(parseCpuCores(null)).toBe(0);
    expect(parseCpuCores(undefined)).toBe(0);
  });
});

describe('parseMem (→ MiB)', () => {
  it('converts Ki/Mi/Gi/Ti', () => {
    expect(parseMem('32986188Ki')).toBe(Math.round(32986188 / 1024));
    expect(parseMem('512Mi')).toBe(512);
    expect(parseMem('2Gi')).toBe(2048);
    expect(parseMem('1Ti')).toBe(1024 * 1024);
  });
  it('decimal SI suffixes are 1000-based bytes (P4: codex)', () => {
    expect(parseMem('500M')).toBe(Math.round(500e6 / (1024 * 1024))); // 477 MiB
    expect(parseMem('1G')).toBe(Math.round(1e9 / (1024 * 1024)));     // 954 MiB
    expect(parseMem('128974848k')).toBe(Math.round(128974848e3 / (1024 * 1024)));
  });
  it('bare quantity is BYTES, not MiB (P4: codex)', () => {
    expect(parseMem('134217728')).toBe(128); // 128 MiB in bytes
    expect(parseMem('100')).toBe(0);         // 100 bytes rounds to 0 MiB
    expect(parseMem('')).toBe(0);
    expect(parseMem(null)).toBe(0);
    expect(parseMem('abc')).toBe(0);
  });
});

describe('aggregateNodeResources', () => {
  const nodes: NodeRow[] = [
    { name: 'n1', status: 'Ready', roles: '', version: '', instanceType: '', zone: '', age: '', cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 8192, memAllocatable: 8000 },
    { name: 'n2', status: 'Ready', roles: '', version: '', instanceType: '', zone: '', age: '', cpuCapacity: 2, cpuAllocatable: 2, memCapacity: 4096, memAllocatable: 4000 },
  ];
  const pods: PodRow[] = [
    { name: 'a', namespace: 'd', status: 'Running', node: 'n1', restarts: 0, age: '', cpuRequest: 1, memRequest: 2000 },
    { name: 'b', namespace: 'd', status: 'Running', node: 'n1', restarts: 0, age: '', cpuRequest: 1, memRequest: 2000 },
    { name: 'c', namespace: 'd', status: 'Running', node: 'n2', restarts: 0, age: '', cpuRequest: 0.5, memRequest: 1000 },
    { name: 'orphan', namespace: 'd', status: 'Pending', node: '', restarts: 0, age: '', cpuRequest: 9, memRequest: 9999 },
  ];

  it('sums per-node requests + podCount and computes clamped pct', () => {
    const agg = aggregateNodeResources(nodes, pods);
    const n1 = agg.find((a) => a.name === 'n1')!;
    expect(n1.cpuRequest).toBe(2);
    expect(n1.memRequest).toBe(4000);
    expect(n1.podCount).toBe(2);
    expect(n1.cpuPct).toBe(50); // 2/4
    expect(n1.memPct).toBe(50); // 4000/8000
    const n2 = agg.find((a) => a.name === 'n2')!;
    expect(n2.cpuRequest).toBe(0.5);
    expect(n2.podCount).toBe(1);
    expect(n2.cpuPct).toBe(25); // 0.5/2
  });
  it('ignores pods with no node assignment (orphans)', () => {
    const agg = aggregateNodeResources(nodes, pods);
    expect(agg.reduce((s, a) => s + a.podCount, 0)).toBe(3); // orphan excluded
  });
  it('reports 0 pct when allocatable is 0', () => {
    const agg = aggregateNodeResources(
      [{ name: 'z', status: '', roles: '', version: '', instanceType: '', zone: '', age: '', cpuCapacity: 0, cpuAllocatable: 0, memCapacity: 0, memAllocatable: 0 }],
      [{ name: 'p', namespace: 'd', status: 'Running', node: 'z', restarts: 0, age: '', cpuRequest: 1, memRequest: 100 }],
    );
    expect(agg[0].cpuPct).toBe(0);
    expect(agg[0].memPct).toBe(0);
  });
});
