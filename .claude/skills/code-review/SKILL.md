---
name: code-review
description: Use when reviewing an AWSops diff or pull request for correctness, security, and policy compliance
triggers: review, PR, code quality
---

# Code Review

Read root `CLAUDE.md`, `AGENTS.md`, `docs/decisions/BASELINE.md`, and the scoped
instructions for changed files. Establish the review base and HEAD.

1. Trace the changed execution path, callers, inputs, tests, and deployment wiring.
   A finding needs a concrete trigger and impact, not a match against stale prose.
2. Check BFF authorization/revocation/ownership, bounded input, parameterized SQL,
   sensitive outputs, and SSRF controls. `/api/*` is the web API prefix. Established
   scoped SDK reads are valid; heavy jobs use dedicated authorized enqueue routes.
3. Preserve the product gates: AWS-resource mutation/autonomy is FROZEN; governed
   external-data writes follow ADR-007. Check BASELINE for prerequisites and the
   narrow ADR-015 exception. Disabled substrate is not itself a regression.
4. Compare component props, exports, routing registries, and query contracts with
   source. Named helpers and server components are valid. Aurora `$1` parameters
   are expected. English-only docs leave application i18n intact; bilingual
   changelog parity and per-PR changelog bullets are not required.
5. Report severity, file/line, trigger, impact, and a minimal fix in English.
   Separate existing limitations, documentation drift, and missing verification.

When PR completion is assigned, follow the user's latest-HEAD review, fix,
validation, and merge procedure. Missing/failed required review coverage never
counts as approval; a new HEAD needs review again.
