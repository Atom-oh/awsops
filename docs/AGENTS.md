<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 5ae1ecbe08a9 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

## Module: `docs/`

Project documentation, organized by purpose. This directory is a documentation index; subdirectories each carry their own context file.

### Layout (what lives where)
- `architecture.md` — system architecture (single file).
- `onboarding.md` — new-teammate onboarding.
- `INSTALL_GUIDE.md` / `TROUBLESHOOTING.md` — install steps / general troubleshooting.
- `decisions/` — ADRs (Architecture Decision Records).
- `runbooks/` — per-scenario operational response guides.
- `reviews/` — code-review / cross-review outputs.
- `plans/` — feature design/planning docs.
- `superpowers/reference/` — current per-component design reference; **one file per component is the single source of truth**.
- `superpowers/archive/` — historical specs/plans, **superseded by `reference/`** (do not treat as current).

### Conventions a reviewer must enforce
- **All new docs are bilingual** (Korean + English).
- **ADR filename format:** `NNN-kebab-case-title.md`. New ADR number = highest existing number + 1 (monotonic; no gaps, no reuse).
- Runbooks must follow `docs/runbooks/CLAUDE.md` rules.
- Design content belongs in `superpowers/reference/` (one component = one file). When updating a component's design, edit its reference file rather than adding parallel/duplicate docs or reviving archived ones.

### Boundaries / gotchas
- `reference/` is authoritative; `archive/` is dead history — flag any change that edits archive as if current, or that splits a component's design across multiple reference files.
- This is a docs tree only — no application logic. Watch for accidental secrets/credentials in committed docs (account IDs, ARNs, domains, tokens) and reject them.

### v1 vs v2 scope note
The repo runs a legacy v1 app (`src/`, CDK/EC2) in parallel with the current v2 architecture (`web/`, `terraform/v2/`). Docs may cover either; when reviewing design references, confirm which line a doc targets so v1 rules aren't applied to v2 (or vice versa).
