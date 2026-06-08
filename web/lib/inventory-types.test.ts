import { describe, it, expect } from 'vitest';
import { INVENTORY_TYPES, inventoryGroups } from './inventory-types';

describe('INVENTORY_TYPES registry', () => {
  it('has the 22 wave types (D2 13 + D3 9)', () => {
    const keys = Object.keys(INVENTORY_TYPES);
    expect(keys).toContain('ec2'); expect(keys).toContain('s3'); expect(keys).toContain('iam_role');
    expect(keys).toContain('cloudfront'); expect(keys).toContain('cloudwatch_alarm'); expect(keys).toContain('msk');
    expect(keys.length).toBe(22);
  });
  it('every type has a label, group, and >=1 column', () => {
    for (const [k, v] of Object.entries(INVENTORY_TYPES)) {
      expect(v.label, k).toBeTruthy(); expect(v.group, k).toBeTruthy();
      expect(v.columns.length, k).toBeGreaterThan(0);
      for (const c of v.columns) { expect(c.key).toBeTruthy(); expect(c.label).toBeTruthy(); }
    }
  });
  it('groups the types', () => {
    const g = inventoryGroups();
    expect(g.find((x) => x.group === 'Compute')?.types).toContain('ec2');
    expect(g.find((x) => x.group === 'Network')?.types).toContain('vpc');
    expect(g.find((x) => x.group === 'Monitoring')?.types).toContain('cloudwatch_alarm');
  });
  it('stateKey/distKey (when present) reference a column key, resource_id, region, or a non-empty data field', () => {
    const VIRTUAL = new Set(['resource_id', 'region']);
    for (const [k, v] of Object.entries(INVENTORY_TYPES)) {
      const colKeys = new Set(v.columns.map((c) => c.key));
      const valid = (field: string) =>
        typeof field === 'string' && field.length > 0 && (colKeys.has(field) || VIRTUAL.has(field));
      if (v.stateKey !== undefined) expect(valid(v.stateKey), `${k}.stateKey=${v.stateKey}`).toBe(true);
      if (v.distKey !== undefined) expect(valid(v.distKey), `${k}.distKey=${v.distKey}`).toBe(true);
    }
  });
  it('ec2 has stateKey=instance_state and distKey=instance_type', () => {
    expect(INVENTORY_TYPES.ec2.stateKey).toBe('instance_state');
    expect(INVENTORY_TYPES.ec2.distKey).toBe('instance_type');
  });
});
