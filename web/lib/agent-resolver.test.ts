// web/lib/agent-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAgent, pickCustomAgent, SAFEGUARD_LINE } from './agent-resolver';
import type { AgentWithSkills } from './catalog';
import type { AgentSpace } from './agent-space';

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

describe('resolveAgent — Phase 2 server-side tool-allowlist enforcement', () => {
  // A custom agent declaring two tools at the security gateway. Both are REAL IAM tools present in
  // KNOWN_TOOL_CATALOG.security (ADR-039 Task 3 populated it from create_targets.py iam-mcp-target),
  // so the known-catalog intersection keeps both — the test still demonstrates the skill-declared union.
  const customTwoTools: AgentWithSkills = {
    ...custom,
    skills: [
      { name: 'cis-pack', instructions: 'Always cite the control id.', contentHash: 'h1', ord: 0,
        toolAllowlist: ['simulate_principal_policy', 'get_account_security_summary'] },
    ],
  };

  it('built-in branch is byte-identical to Phase 1 — a space has NO effect', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: ['x'], enabledAgentIds: [], enabledSkillIds: [], version: 5,
    };
    const spec = resolveAgent('security', [], space);
    expect(spec.tier).toBe('builtin');
    expect(spec.gateway).toBe('security');
    expect(spec.skill).toBe('security');
    expect(spec.agentName).toBe('security');
    expect(spec.skillHashes).toEqual([]);
    expect(spec.toolAllowlist).toBeUndefined();
    expect(spec.spaceVersion).toBeUndefined();
    // Must equal the no-space Phase-1 built-in output, key-for-key.
    expect(spec).toEqual(resolveAgent('security', []));
  });

  it('no space ⇒ skill-declared union ∩ known security catalog (both tools are valid IAM tools)', () => {
    const spec = resolveAgent('compliance', [customTwoTools]); // no 3rd arg
    expect(spec.toolAllowlist).toEqual(['simulate_principal_policy', 'get_account_security_summary']);
    expect(spec.spaceVersion).toBeUndefined();
  });

  it('enforcement removes a disallowed tool (account cap can only REMOVE)', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: ['simulate_principal_policy'],
      enabledAgentIds: [], enabledSkillIds: [], version: 2,
    };
    const spec = resolveAgent('compliance', [customTwoTools], space);
    expect(spec.toolAllowlist).toEqual(['simulate_principal_policy']);
  });

  it('empty space cap = no cap (advisory; equals Phase-1)', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: [], enabledAgentIds: [], enabledSkillIds: [], version: 7,
    };
    const spec = resolveAgent('compliance', [customTwoTools], space);
    expect(spec.toolAllowlist).toEqual(resolveAgent('compliance', [customTwoTools]).toolAllowlist);
  });

  it('carries spaceVersion on the custom spec when a space is passed, undefined otherwise', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: ['simulate_principal_policy'],
      enabledAgentIds: [], enabledSkillIds: [], version: 9,
    };
    expect(resolveAgent('compliance', [customTwoTools], space).spaceVersion).toBe(9);
    expect(resolveAgent('compliance', [customTwoTools]).spaceVersion).toBeUndefined();
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
