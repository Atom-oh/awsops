// web/lib/skill-validation.ts
// ADR-031 Phase 1 — pure validation for admin-authored skills/agents.
// Gateways mirror agent/agent.py SKILL_BASE keys (the bindable built-in tool sets).
export const KNOWN_GATEWAYS = ['network', 'container', 'iac', 'data', 'security', 'monitoring', 'cost', 'ops'] as const;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_INSTRUCTIONS = 50_000;
const MAX_PERSONA = 20_000;

export interface ValidationResult { ok: boolean; errors: string[]; }

export function validateSkill(s: { name?: string; description?: string; instructions?: string; toolAllowlist?: unknown }): ValidationResult {
  const errors: string[] = [];
  if (!s.name || !NAME_RE.test(s.name)) errors.push('name must be kebab-case, 2-64 chars');
  if (!s.description?.trim()) errors.push('description is required');
  if (typeof s.instructions !== 'string' || s.instructions.length === 0) errors.push('instructions required');
  else if (s.instructions.length > MAX_INSTRUCTIONS) errors.push(`instructions exceed ${MAX_INSTRUCTIONS} chars`);
  if (!Array.isArray(s.toolAllowlist) || !s.toolAllowlist.every((t) => typeof t === 'string')) errors.push('toolAllowlist must be string[]');
  return { ok: errors.length === 0, errors };
}

export function validateAgent(a: { name?: string; description?: string; persona?: string; gateway?: string; routingKeywords?: unknown }): ValidationResult {
  const errors: string[] = [];
  if (!a.name || !NAME_RE.test(a.name)) errors.push('name must be kebab-case, 2-64 chars');
  if (!a.description?.trim()) errors.push('description is required');
  if ((a.persona?.length ?? 0) > MAX_PERSONA) errors.push(`persona exceeds ${MAX_PERSONA} chars`);
  if (!(KNOWN_GATEWAYS as readonly string[]).includes(a.gateway ?? '')) errors.push(`gateway must be one of ${KNOWN_GATEWAYS.join(', ')}`);
  if (!Array.isArray(a.routingKeywords) || !a.routingKeywords.every((k) => typeof k === 'string')) errors.push('routingKeywords must be string[]');
  return { ok: errors.length === 0, errors };
}
