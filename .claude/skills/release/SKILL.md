---
name: release
description: Use when preparing or executing an authorized AWSops release
triggers: release, version, tag
---

# Release

Use root `CLAUDE.md`, `docs/decisions/BASELINE.md`, the root `Makefile`, and
`.claude/commands/deploy.md`. Confirm the intended revision from the request and
existing release conventions.

1. Run relevant tests, required CI checks, and the production web build. Treat
   skipped checks as gaps, not passes.
2. Update release metadata only where the implementation consumes it. The sidebar
   version comes from root `CHANGELOG.md` via `web/lib/changelog.ts`; do not add a
   separate hard-coded sidebar version.
3. Write concise English changelog entries for net behavior. Amend an existing
   feature entry instead of adding duplicate fix bullets or review-round history.
   The parser supports English-only entries; bilingual parity is not required.
   Preserve merged migration contents, including checksum-covered `-- since:`
   headers.
4. Follow the authorized PR/release workflow. Deployment uses the v2 Make targets;
   shared Terraform changes use a saved plan applied by the controller.
5. Verify ECS stability and `/api/health` for a web deployment. Report revision,
   release/tag or PR details when applicable, and actual validation outcomes.

Preparing a release does not implicitly authorize publishing, deployment, or
changing product gates.
