// web/lib/agent-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAgent, pickCustomAgent, SAFEGUARD_LINE } from './agent-resolver';
import type { AgentWithSkills } from './catalog';

const custom: AgentWithSkills = {
  id: 1, name: 'compliance', description: 'CIS expert', persona: 'You are a CIS auditor.',
  gateway: 'security', tier: 'custom', version: 3, enabled: true, routingKeywords: ['cis', 'benchmark'],
  skills: [
    { name: 'cis-pack', instructions: 'Always cite the control id.', contentHash: 'h1', ord: 0, toolAllowlist: ['simulate_principal_policy'] },
    { name: 'tone', instructions: 'Be concise.', contentHash: 'h2', ord: 1, toolAllowlist: [] },
  ],
};

describe('resolveAgent', () => {
  it('built-in passthrough when routeKey is not a custom agent (no override)', () => {
    const spec = resolveAgent('security', []);
    expect(spec.tier).toBe('builtin');
    expect(spec.gateway).toBe('security');
    expect(spec.skill).toBe('security');
    expect(spec.systemPromptOverride).toBeUndefined();
    expect(spec.skillHashes).toEqual([]);
  });

  it('composes safeguard + persona + ordered skills for a custom agent', () => {
    const spec = resolveAgent('compliance', [custom]);
    expect(spec.tier).toBe('custom');
    expect(spec.gateway).toBe('security');
    expect(spec.systemPromptOverride!.startsWith(SAFEGUARD_LINE)).toBe(true);
    expect(spec.systemPromptOverride).toContain('You are a CIS auditor.');
    const o = spec.systemPromptOverride!;
    expect(o.indexOf('Always cite')).toBeLessThan(o.indexOf('Be concise'));
    expect(spec.skillHashes).toEqual(['h1', 'h2']);
    expect(spec.toolAllowlist).toEqual(['simulate_principal_policy']);
    expect(spec.agentVersion).toBe(3);
    expect(spec.agentName).toBe('compliance');
  });

  it('falls back to built-in when the named agent is disabled/absent', () => {
    const spec = resolveAgent('compliance', [{ ...custom, enabled: false }]);
    expect(spec.tier).toBe('builtin');
    expect(spec.gateway).toBe('compliance'); // routeKey passes through as gateway
  });
});

describe('pickCustomAgent', () => {
  it('matches an enabled custom agent by routing keyword (case-insensitive)', () => {
    expect(pickCustomAgent('run a CIS benchmark please', [custom])).toBe('compliance');
  });
  it('returns null when nothing matches', () => {
    expect(pickCustomAgent('what is my bill', [custom])).toBeNull();
  });
  it('ignores disabled candidates', () => {
    expect(pickCustomAgent('cis', [{ ...custom, enabled: false }])).toBeNull();
  });
});
