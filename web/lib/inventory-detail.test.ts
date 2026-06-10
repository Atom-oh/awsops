import { describe, it, expect } from 'vitest';
import { formatDetailValue, buildDetailGroups } from './inventory-detail';
import { INVENTORY_TYPES } from './inventory-types';

describe('formatDetailValue', () => {
  it('classifies booleans', () => {
    expect(formatDetailValue('encrypted', true)).toEqual({ kind: 'boolean', bool: true });
    expect(formatDetailValue('encrypted', false)).toEqual({ kind: 'boolean', bool: false });
  });
  it('classifies empty (null / undefined / empty string)', () => {
    expect(formatDetailValue('x', null).kind).toBe('empty');
    expect(formatDetailValue('x', undefined).kind).toBe('empty');
    expect(formatDetailValue('x', '').kind).toBe('empty');
  });
  it('classifies objects as code (pretty JSON)', () => {
    const f = formatDetailValue('tags', { Name: 'web' });
    expect(f.kind).toBe('code');
    expect(f.text).toContain('"Name"');
  });
  it('classifies known state keys as state', () => {
    expect(formatDetailValue('instance_state', 'running')).toEqual({ kind: 'state', text: 'running' });
    expect(formatDetailValue('status', 'available').kind).toBe('state');
  });
  it('classifies other scalars as text', () => {
    expect(formatDetailValue('name', 'web-1')).toEqual({ kind: 'text', text: 'web-1' });
    expect(formatDetailValue('memory_size', 512)).toEqual({ kind: 'text', text: '512' });
  });
});

describe('buildDetailGroups', () => {
  const row = { resource_id: 'i-1', region: 'ap-northeast-2', name: 'web', instance_type: 't3.micro', instance_state: 'running', tags: { a: 1 } };

  it('returns one flat unlabelled group when no spec (legacy behavior, raw keys, insertion order)', () => {
    const g = buildDetailGroups(row);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('');
    expect(g[0].items.map((i) => i.key)).toEqual(['resource_id', 'region', 'name', 'instance_type', 'instance_state', 'tags']);
    expect(g[0].items.map((i) => i.label)).toEqual(['resource_id', 'region', 'name', 'instance_type', 'instance_state', 'tags']);
  });

  it('groups by spec sections with friendly labels and an Other bucket', () => {
    const g = buildDetailGroups(row, INVENTORY_TYPES.ec2);
    const labels = g.map((x) => x.label);
    expect(labels).toContain('Identity');
    expect(labels).toContain('Other'); // tags is not in any ec2 section
    // friendly label from the column spec
    const all = g.flatMap((x) => x.items);
    expect(all.find((i) => i.key === 'instance_type')?.label).toBe('Type');
    // every present key appears exactly once across groups
    const keys = all.map((i) => i.key).sort();
    expect(keys).toEqual(['instance_state', 'instance_type', 'name', 'region', 'resource_id', 'tags']);
  });

  it('skips section keys absent from the row and drops empty sections', () => {
    const sparse = { resource_id: 'i-2', region: 'us-east-1' };
    const g = buildDetailGroups(sparse, INVENTORY_TYPES.ec2);
    // only sections that have at least one present key survive; no duplicates
    expect(g.every((x) => x.items.length > 0)).toBe(true);
    const keys = g.flatMap((x) => x.items.map((i) => i.key)).sort();
    expect(keys).toEqual(['region', 'resource_id']);
  });
});
