import { describe, it, expect, vi } from 'vitest';
import { traversalSql, downstream, upstream, blastRadius } from './graph-query';

describe('graph-query traversal SQL', () => {
  it('uses the PG17 CYCLE clause (no manual visited array)', () => {
    expect(traversalSql('down')).toContain('CYCLE node SET is_cycle USING path');
  });
  it('down follows source→target; up reverses', () => {
    const d = traversalSql('down');
    expect(d).toContain('e.source = w.node');
    expect(d).toContain('SELECT e.target');
    const u = traversalSql('up');
    expect(u).toContain('e.target = w.node');
    expect(u).toContain('SELECT e.source');
  });
  it('bounds depth', () => {
    expect(traversalSql('down')).toMatch(/w\.depth < \d+/);
  });
});

describe('graph-query functions', () => {
  it('downstream queries WITH RECURSIVE bound to the id', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [{ id: 'x', depth: 1 }] }));
    const r = await downstream({ query } as never, 'cf:D1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE'), ['cf:D1']);
    expect(r[0].id).toBe('x');
  });
  it('blastRadius is the upstream traversal', () => {
    expect(blastRadius).toBe(upstream);
  });
});
