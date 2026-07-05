// S2 merge invariants — 9-section routing consistency (ADR-004 amended 2026-06-24).
// Red until web/lib/merge-invariants.ts implements the read helpers.
import { describe, it, expect } from 'vitest';
import {
  readCatalogGateways,
  readSectionKeys,
  readRouteRuleKeys,
  readAgentAlias,
  scanV1PathLeak,
} from './merge-invariants';

describe('S2 routing consistency', () => {
  it('catalog.py provisions exactly 9 gateways', () => {
    const gw = readCatalogGateways();
    expect(gw).toHaveLength(9);
    expect(gw).toContain('external-obs');
  });

  it('sections.ts keys and route.ts RULES keys are the same set', () => {
    const sections = [...readSectionKeys()].sort();
    const rules = [...readRouteRuleKeys()].sort();
    expect(rules).toEqual(sections);
  });

  it('section keys with observability→external-obs alias match GATEWAYS', () => {
    const alias = (k: string) => (k === 'observability' ? 'external-obs' : k);
    const sections = [...new Set(readSectionKeys().map(alias))].sort();
    const gateways = [...readCatalogGateways()].sort();
    expect(sections).toEqual(gateways);
  });

  it('agent.py runtime _GATEWAY_ALIAS maps observability to external-obs', () => {
    expect(readAgentAlias()).toMatchObject({ observability: 'external-obs' });
  });

  it('no quote-prefixed /awsops/ v1 path literal leaks into web source', () => {
    // NOTE: substring scanning is wrong here — /ops/awsops-v2/... SSM paths are
    // legitimate (18 baseline hits). Only a path literal STARTING with /awsops/
    // (quote-prefixed) is a v1 basePath leak. The scanner must exclude
    // merge-invariants.ts / merge-invariants.test.ts (they embed the pattern itself).
    expect(scanV1PathLeak()).toEqual([]);
  });
});
