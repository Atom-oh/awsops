<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 319a4e0c31ed · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# Runbooks module

Operational playbooks, one Markdown file per failure/operational scenario (service start, deploy, add-page, multi-account setup, alert-pipeline, cache-warmer, Cognito/Lambda@Edge auth). Pure documentation — no executable code lives here.

## Conventions a reviewer must enforce
- **Filename**: `kebab-case.md`, domain-then-topic ordering.
- **Mandatory structure**, in order: symptoms → candidate causes → verification commands → action → related files/ADRs. Reject runbooks that skip the diagnosis step or jump straight to fixes.
- **Bilingual**: Korean + English side by side.
- **Commands must be copy-paste runnable** (no pseudo-commands or elided placeholders that won't execute).
- Each runbook **must cite related file paths** and the relevant **ADR number(s)** at the bottom.
- A new runbook must be **registered in the index** in `CLAUDE.md`, and should use an existing runbook (e.g. start-services, deploy-new-version) as the structural template.

## Boundaries
- This directory is a doc sink only: it imports nothing and is imported by nothing. Review focus is editorial — structure, accuracy of cited paths/commands, and ADR cross-references — not code.
- Runbooks may reference both stacks; the repo runs a legacy v1 app (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) in parallel with v2 (`web/` + `terraform/v2/`, root path, Aurora). v1 rules do not apply to v2. When a runbook's commands target one stack, confirm they aren't mistakenly applied to the other (e.g. `/awsops` prefix and Steampipe Pool are v1-only).

## Gotchas / banned patterns
- Do not let a runbook embed secrets, AWS account IDs, ARNs, or live domains — keep those out of committed docs.
- Stale cited paths/ADR numbers are the most common defect: verify referenced files still exist and ADR numbers are current.
