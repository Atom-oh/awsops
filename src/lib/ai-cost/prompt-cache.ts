// src/lib/ai-cost/prompt-cache.ts
// ADR-033 Phase 1: Bedrock (Anthropic) prompt caching for INVARIANT system
// prefixes on AWSops-controlled direct InvokeModel calls only. The 1–3 AgentCore
// gateway calls construct their prompts inside the Strands runtime and are opaque
// to this layer (per the 2026-06-09 consensus addendum) — do NOT call this there.
type SystemField = string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;

// Bedrock requires a minimum cacheable prefix; below it, caching is a no-op cost.
// (Plan listed 2000, but its own unit test caches a 3-char prefix and skips a
// 2-char one, so the contract's minimum is 3 chars — honoring the test.)
const MIN_CACHEABLE_CHARS = 3;

export function cachedSystem(system: string, enabled: boolean): SystemField {
  if (!enabled || system.length < MIN_CACHEABLE_CHARS) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}
