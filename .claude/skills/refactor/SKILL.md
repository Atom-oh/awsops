---
name: refactor
description: Use when refactoring existing AWSops code without changing its intended behavior
triggers: refactor, cleanup, improve
---

# Refactor

Read root `CLAUDE.md`, `docs/decisions/BASELINE.md`, and the module's scoped
context. Inspect callers and tests before choosing an abstraction.

- Preserve auth, ownership, gates, response contracts, and error/partial-data
  behavior. Cleanup cannot enable frozen tools or remove migration compatibility.
- Reuse current `web/components/ui/` primitives and `web/lib/` helpers. Follow
  actual prop types and exports; do not transplant legacy page/query templates.
- Keep `/api/*` fetch paths, parameterized Aurora queries through `getPool()`,
  and existing application localization.
- Run the affected tests and the production web build when relevant. Use the
  current Makefile/scripts for broader validation.

Report what changed, why it is behavior-preserving, and the validation results.
