<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 1c86ce9eaf8e · generated-at: 2026-08-12 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Runbooks module

Operational playbooks, one Markdown file per failure/operational scenario (service start, deploy, add-page, multi-account setup, alert-pipeline, cache-warmer, Cognito/Lambda@Edge auth). Pure documentation — no executable code lives here.

## Conventions a reviewer must enforce
- **Filename**: `kebab-case.md`, domain-then-topic ordering.
- **Mandatory structure**, in order: symptoms → candidate causes → verification commands → action → related files/ADRs. Reject runbooks that skip diagnosis and jump straight to fixes.
- **Bilingual**: Korean + English side by side.
- **Commands must be copy-paste runnable** (no pseudo-commands or elided placeholders).
- Each runbook **must cite related file paths** and the relevant **ADR number(s)** at the bottom.
- A new runbook must be **registered in the index** in `docs/runbooks/CLAUDE.md`, and should use an existing runbook (e.g. `start-services.md`, `deploy-new-version.md`) as the structural template.

## Boundaries
- Doc sink only: imports nothing, is imported by nothing. Review focus is editorial — structure, accuracy of cited paths/commands, ADR cross-references — not code.
- **v2 is live on `main`; v1 is decommissioned** (ADR-016) — its application code left the tree 2026-07-12 (`git tag v1-pre-code-removal-20260712`), only stopped AWS infra remains pending final teardown. v1 does NOT run in parallel with v2. A runbook may still document a **legacy v1 procedure for historical/decommission reference** (marked `⚠️ v1(legacy)` in the index) — that's not the same as v1 being a live, parallel target. Confirm a runbook's commands aren't mistakenly presented as applying to v2 (e.g. `/awsops` prefix and the Steampipe Pool are v1-only).

## Gotchas / banned patterns
- Do not let a runbook embed secrets, AWS account IDs, ARNs, or live domains.
- Stale cited paths/ADR numbers are the most common defect: verify referenced files still exist and ADR numbers are current.
