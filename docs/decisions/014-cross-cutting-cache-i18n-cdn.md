# ADR-014: Caching, Language, and CDN Policy

## Status

Accepted **2026-06-22**, consolidating legacy ADRs 017, 026, and 028.
Language scope amended **2026-07-19**; report-language support recorded **2026-08-31**.
Repository evidence checked **2026-09-13** corrects the former claim that chat language is still unwired.

## Context

Operational pages need scoped freshness and predictable language without shared edge caches serving
user-specific data. Historical prewarming and a translated UI do not prove every data/AI path shares
those behaviors.

## Decision

- Keep application caches scoped to their domain/account and disclose freshness where relevant.
  The legacy background query warmer is not a current v2 implementation requirement: its live
  Steampipe execution path is disabled. Inspect actual per-module caches instead of claiming every
  request is prewarmed or that caching prevents all stale responses.
- `LanguageProvider` and `web/lib/i18n.ts` own the UI language set, flat translation maps, and fallback.
  Language preference persists locally without locale route prefixes. Translation coverage remains
  feature-specific; developer documentation language is separate from product/user-guide localization.
- Diagnosis reports carry `lang` through worker sections and document rendering. The operator
  data-coverage appendix retains its recorded Korean text. Chat now passes `responseLanguage` through
  `web/lib/agentcore.ts` to runtime language directives; do not re-flag this as wholly unimplemented.
  Prompt instructions guide model language but do not guarantee perfect output compliance.
- Disable CloudFront caching for default dynamic page/API behavior; optimize only hashed
  `/_next/static/*` assets. Authentication is attached at viewer-request, before cache lookup.
  Its execution point is independent of whether dynamic caching is disabled.

## Consequences

Dynamic traffic reaches the origin, avoiding shared edge-cache leakage but increasing origin load.
Application TTLs still allow bounded staleness; no-cache at CloudFront is not a freshness guarantee
for underlying data. Bundled language maps are simple and router-independent, with incremental
coverage rather than a promise that every page or model response is fully translated.

## Six Pillars

Performance Efficiency: scoped app caches and static asset caching. Security: prevent shared caching
of dynamic user data. Operational Excellence: explicit language/freshness ownership.

## Evidence

`terraform/v2/foundation/edge.tf`, `web/lib/{i18n,aws-data,agentcore}.ts`,
`web/app/api/chat/route.ts`, `agent/agent.py`, and `scripts/v2/workers/diagnosis/`.
