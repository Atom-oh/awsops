// src/lib/ai-cost/prompt-cache.ts
// ADR-033 Phase 1: Bedrock (Anthropic) prompt caching for INVARIANT system
// prefixes on AWSops-controlled direct InvokeModel calls only. The 1–3 AgentCore
// gateway calls construct their prompts inside the Strands runtime and are opaque
// to this layer (per the 2026-06-09 consensus addendum) — do NOT call this there.
type SystemField = string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;

// Bedrock/Anthropic prompt caching has a real minimum cacheable prefix (~1k+
// tokens); below it a cache_control marker is silently ignored, so adding it is
// pointless. 2000 chars is a conservative char-based proxy for that floor — the
// invariant system prompts we cache (classifier registry, WA-15 / CIS-431, MCP
// schemas) are all far larger, so this never suppresses a real cache hit.
const MIN_CACHEABLE_CHARS = 2000;

export function cachedSystem(system: string, enabled: boolean): SystemField {
  if (!enabled || system.length < MIN_CACHEABLE_CHARS) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}
