// web/lib/skill-validation.ts
// ADR-031 Phase 1 — pure validation for admin-authored skills/agents.
// Gateways mirror agent/agent.py SKILL_BASE keys (the bindable built-in tool sets).
// 9 routed chat sections (ADR-038 routing; external-obs gateway per ADR-004 amendment): the 8
// AWS-domain gateways + `observability` (external-obs: Prometheus/ClickHouse). Mirrors the
// agent.py SKILL_BASE roles (which include an "observability" persona, aliased to external-obs).
// Custom agents may target any of these.
import { sectionByKey } from './sections';

export function isReservedAgentName(name: string): boolean {
  return name === 'auto' || name === 'code' || !!sectionByKey(name);
}

export const KNOWN_GATEWAYS = ['network', 'container', 'iac', 'data', 'security', 'monitoring', 'cost', 'ops', 'observability'] as const;
// ADR-039 agent-type lifecycle roles. SOURCE OF TRUTH shared with the migration
// `agents_agent_type_check` CHECK (01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql) — keep in sync.
export const AGENT_TYPES = ['generic', 'on_demand', 'triage', 'rca', 'mitigation', 'evaluation'] as const;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const MAX_INSTRUCTIONS = 50_000;
const MAX_PERSONA = 20_000;

export interface ValidationResult { ok: boolean; errors: string[]; }
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function validateSkill(s: unknown): ValidationResult {
  if (!isRecord(s)) return { ok: false, errors: ['skill must be an object'] };
  const errors: string[] = [];
  if (typeof s.name !== 'string' || !NAME_RE.test(s.name)) errors.push('name must be kebab-case, 2-64 chars');
  if (typeof s.description !== 'string' || !s.description.trim()) errors.push('description is required');
  if (typeof s.instructions !== 'string' || !s.instructions.trim()) errors.push('instructions required');
  else if (s.instructions.length > MAX_INSTRUCTIONS) errors.push(`instructions exceed ${MAX_INSTRUCTIONS} chars`);
  if (!isStringArray(s.toolAllowlist)) errors.push('toolAllowlist must be string[]');
  // ADR-039 optional fields (default applied downstream): agentTypes ⊆ AGENT_TYPES, referenceKeys string[]
  if (s.agentTypes !== undefined) {
    if (!isStringArray(s.agentTypes)) errors.push('agentTypes must be string[]');
    else if (!s.agentTypes.every((t) => (AGENT_TYPES as readonly string[]).includes(t))) errors.push(`agentTypes must each be one of ${AGENT_TYPES.join(', ')}`);
  }
  if (s.referenceKeys !== undefined && !isStringArray(s.referenceKeys)) errors.push('referenceKeys must be string[]');
  return { ok: errors.length === 0, errors };
}

export function validateAgent(a: unknown): ValidationResult {
  if (!isRecord(a)) return { ok: false, errors: ['agent must be an object'] };
  const errors: string[] = [];
  if (typeof a.name !== 'string' || !NAME_RE.test(a.name)) errors.push('name must be kebab-case, 2-64 chars');
  else if (isReservedAgentName(a.name)) errors.push('name is reserved for built-in chat routing');
  if (typeof a.description !== 'string' || !a.description.trim()) errors.push('description is required');
  if (a.persona !== undefined && typeof a.persona !== 'string') errors.push('persona must be a string');
  else if (typeof a.persona === 'string' && a.persona.length > MAX_PERSONA) errors.push(`persona exceeds ${MAX_PERSONA} chars`);
  if (typeof a.gateway !== 'string' || !(KNOWN_GATEWAYS as readonly string[]).includes(a.gateway)) errors.push(`gateway must be one of ${KNOWN_GATEWAYS.join(', ')}`);
  if (!isStringArray(a.routingKeywords) || a.routingKeywords.some((k) => !k.trim())) errors.push('routingKeywords must contain non-empty strings');
  // ADR-039 optional fields (default applied downstream): agentType ∈ AGENT_TYPES, gateways ⊆ KNOWN_GATEWAYS
  if (a.agentType !== undefined && !(AGENT_TYPES as readonly string[]).includes(a.agentType as string)) errors.push(`agentType must be one of ${AGENT_TYPES.join(', ')}`);
  if (a.gateways !== undefined) {
    if (!isStringArray(a.gateways)) errors.push('gateways must be string[]');
    else if (!a.gateways.every((g) => (KNOWN_GATEWAYS as readonly string[]).includes(g))) errors.push(`gateways must each be one of ${KNOWN_GATEWAYS.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}
