// web/lib/skill-validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateSkill, validateAgent, KNOWN_GATEWAYS } from './skill-validation';

describe('skill-validation', () => {
  it('accepts a well-formed skill', () => {
    expect(validateSkill({ name: 'cis-pack', description: 'CIS checks', instructions: 'do CIS', toolAllowlist: [] }).ok).toBe(true);
  });
  it('rejects empty name and over-long instructions', () => {
    expect(validateSkill({ name: '', description: 'd', instructions: 'i', toolAllowlist: [] }).ok).toBe(false);
    expect(validateSkill({ name: 'n', description: 'd', instructions: 'x'.repeat(50_001), toolAllowlist: [] }).ok).toBe(false);
  });
  it('rejects a non-kebab name', () => {
    expect(validateSkill({ name: 'Bad Name', description: 'd', instructions: 'i', toolAllowlist: [] }).ok).toBe(false);
  });
  it('rejects a non-string-array toolAllowlist', () => {
    expect(validateSkill({ name: 'n', description: 'd', instructions: 'i', toolAllowlist: [1, 2] }).ok).toBe(false);
  });
  it('rejects an agent on an unknown gateway, accepts a known one', () => {
    expect(validateAgent({ name: 'a', description: 'd', persona: 'p', gateway: 'nope', routingKeywords: [] }).ok).toBe(false);
    expect(validateAgent({ name: 'compliance', description: 'd', persona: 'p', gateway: 'security', routingKeywords: ['cis'] }).ok).toBe(true);
    expect(KNOWN_GATEWAYS).toContain('security');
  });
});
