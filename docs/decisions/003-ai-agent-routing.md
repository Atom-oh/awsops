# ADR-003: Per-Turn AI Routing

## Status

Accepted **2026-06-22**. Consolidates legacy ADRs 002, 025, 038, and 044.
Repository evidence checked **2026-09-13**; historical accuracy/cache measurements are not current
pass criteria or proof that a deployment enabled a flag.

## Context

First-match routing alone misses mixed-domain questions. Routing also needs explicit precedence for
pins, product help, custom agents, disabled agents, and per-turn context.

## Decision

- Route each turn independently; a thread is a conversation container, not an agent-specific session.
  Preserve user/account/thread memory isolation across agent switches.
- Precedence: explicit pin, product-help intent, custom-agent keyword match, then section routing with
  Agent Space filtering. A disabled explicit pin is reported honestly; automatic unavailable routes
  degrade to supported fallback behavior. Switch chips clear a stale pin and intentionally reroute.
- Implementation clarification **2026-09-13**: domain chat reads one fresh account policy/catalog
  context per turn. Failure of either read denies custom candidates; it is not Phase-1 absence.
  Explicit custom pins get an unavailable response without invocation. Built-in pins and product
  help remain usable; automatic built-in fallback identifies its persona and displays a notice.
- `pickGateway()` follows `route.ts` RULES order, first match wins. Hybrid `classifyRoute()` uses a
  distinct single match as its fast path, asks Haiku about ambiguity/unmatched prompts and weak
  catch-all matches, and safely falls back when classification fails. Explicit observability vendor
  matches retain precedence and can preserve other domain candidates.
- Classifier output is validated, bounded, and advisory; it never grants authorization. Keep prompt
  boundaries, timeout/backoff, and the exact model's scoped IAM. The default classifier timeout is 3500ms.
- `hybrid_routing_enabled` defaults false. Its recorded rollout criterion is golden-set accuracy
  at least 85% and improvement at least 15 percentage points over regex; rerun against the reviewed
  code/fixture instead of relying on historical scores.
- `multi_route_synthesis_enabled` separately gates fan-out and its direct-model IAM. Select at most
  three eligible routes, recompute eligibility after filtering, collect with `Promise.allSettled`,
  and synthesize surviving responses. Failure of one route must not discard all evidence.
- Product help uses the bounded AWSops knowledge base through the direct Bedrock assistant path.
  The buffered answer can be presented incrementally without claiming model-token streaming.
- Before activating a section, verify its `SKILL_BASE` persona and actual gateway/tool route.
  `observability` resolves to `external-obs`; `_resolve_gateway_key` intentionally accepts both
  canonical and `v2-` discovered keys. Do not remove this coexistence shim.
- `aws-data` and collector section keys remain registered, but live Steampipe execution is hard-disabled
  in `web/lib/aws-data.ts`; those chat paths fall through to normal routing. Registration is not
  evidence that the historical collector executes.

Chat synthesis is distinct from ADR-006's gated incident lifecycle and ADR-007's integrations.
It does not authorize autonomous mitigation or silently promote chat into incident execution.
Gateway-wide semantic tool search remains deferred; do not infer it from hybrid routing.
The optional `ANTHROPIC_AGENT_LOOP_ENABLED` experiment is governed by ADR-008; client-controlled
`agentLoop` must not be forwarded by the BFF.

## Consequences

Per-turn routing retains context and supports mixed-domain answers with bounded fan-out. Classification
and synthesis add latency and token cost; scoped flags and failure isolation keep those costs explicit.
Golden fixture expectations must follow real RULES order and runtime availability, not static route counts.

## Six Pillars

Operational Excellence and Reliability: explicit precedence and partial-failure handling. Security:
validated advisory routing and real tool boundaries. Performance/Cost/Sustainability: regex fast paths,
bounded fan-out, and agent prompt caching (ADR-008).

## Evidence

`web/lib/{route,classifier,synthesize,assistant,sections}.ts`, `web/app/api/chat/route.ts`,
`web/lib/fixtures/golden-routing.json`, `scripts/v2/routing-accuracy.mjs`, `agent/agent.py`.
