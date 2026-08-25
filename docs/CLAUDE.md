# Documentation

Project documentation organized by purpose. Each subdirectory has its own CLAUDE.md.

## Structure

| Directory | Purpose |
|---|---|
| [architecture.md](architecture.md) | System architecture (single file) |
| [onboarding.md](onboarding.md) | New-joiner onboarding |
| [decisions/](decisions/) | **Decision single source of truth = `BASELINE.md`** + consolidated ADRs 001–020 + `ADR-MAPPING.md` (old ADR 001–046 bodies are at git tag `adr-legacy-2026-06-22`) |
| [reference/](reference/) | Current v2 design, one file per component (single source per component) |
| [runbooks/](runbooks/) | Operational playbooks by scenario |
| [reviews/](reviews/) | Code review / cross-review results |
| [plans/](plans/) | Old planning docs (legacy) — current plans live under `superpowers/plans/` |
| [superpowers/specs/](superpowers/specs/) | Design specs (brainstorming output) |
| [superpowers/plans/](superpowers/plans/) | Implementation plans (writing-plans output) — **a mix of current and frozen/superseded**; frozen-era plans (029–036 remediation, etc.) are not live (ADR-005 FROZEN); current truth is `decisions/BASELINE.md` |
| [history/](history/) | Old history — `archive/` (execution history), etc. Not current truth |
| AI_TEST_*.md | AI assistant test question sets |
| TEST-COVERAGE-PLAN.md | Test coverage plan |

## Conventions
- All new documents are **bilingual Korean/English** — exceptions: (a) **all `CLAUDE.md`-type
  files, regardless of directory, are English-only** (root `CLAUDE.md`, `AGENTS.md`,
  `web/**/CLAUDE.md`, `agent/CLAUDE.md`, `terraform/CLAUDE.md`, `docs/decisions/CLAUDE.md`,
  `docs/runbooks/CLAUDE.md`, `docs/CLAUDE.md` itself, etc. — these are context files Claude Code
  auto-loads, so the goal is context-size savings), and (b) implementation-facing design specs
  under `docs/superpowers/specs/` (technical documents whose primary readers are AI
  agents/implementers) are also **English-only**. "Stays bilingual" applies to a directory's
  **body content**, not its `CLAUDE.md` — `docs/runbooks/*.md` (the runbook bodies, excluding
  `CLAUDE.md`), `docs/decisions/BASELINE.md`/`0NN-*.md` (ADR bodies), and other
  user-/operator-facing documents keep the bilingual rule.
- Decision current truth = `docs/decisions/BASELINE.md`. New ADR = consolidated-ADR highest
  number + 1 (currently **020**); update BASELINE in the same PR.
- ADR filename: `NNN-kebab-case-title.md`.
- **Don't mix current truth (decisions/BASELINE + superpowers/reference) with old
  plans/history.** `superpowers/plans|specs` and `superpowers/archive` contain
  reversed/frozen-era/superseded documents — don't treat them as live guidance; anything about
  mutation/autonomy is settled by ADR-005 FROZEN regardless.
- Runbooks follow the rules in `docs/runbooks/CLAUDE.md`.

## Related Skills
- `/sync-docs` — auto-sync CLAUDE.md
- `/project-init:add-adr` — create a new ADR
- `/project-init:add-runbook` — create a new runbook
- `/project-init:health-check` — verify documentation coverage
