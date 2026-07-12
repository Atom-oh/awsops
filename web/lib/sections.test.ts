import { describe, it, expect } from 'vitest';
import { SECTIONS, AUTO_PRESETS, sectionByKey, activeSections } from './sections';

describe('sections', () => {
  it('has 9 sections with the expected keys', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      'network', 'container', 'data', 'security', 'cost', 'monitoring', 'iac', 'ops', 'observability',
    ]);
  });
  it('marks network/security + data/cost/monitoring + ops active (ops = inventory_read MCP home)', () => {
    expect(activeSections().map((s) => s.key).sort()).toEqual(['cost', 'data', 'monitoring', 'network', 'observability', 'ops', 'security']);
  });
  it('every section has label, icon, color, and >=3 presets', () => {
    for (const s of SECTIONS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
      expect(s.color).toMatch(/^#/);
      expect(s.presets.length).toBeGreaterThanOrEqual(3);
    }
  });
  it('sectionByKey returns the section or undefined', () => {
    expect(sectionByKey('cost')?.label).toBeDefined();
    expect(sectionByKey('nope')).toBeUndefined();
  });
  it('exposes an Auto preset mix', () => {
    expect(AUTO_PRESETS.length).toBeGreaterThanOrEqual(4);
  });
});
