<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: b094a2862d3c · generated-at: 2026-07-01 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

## Module: `docs/`

Project documentation, organized by purpose. This directory is a documentation index; subdirectories each carry their own context file.

### Layout (what lives where)
- `history/architecture-v1.md` — v1-only architecture (archived; renamed from the old `architecture.md`). v2's current architecture lives in `reference/`, not here.
- `onboarding.md` — new-teammate onboarding.
- `INSTALL_GUIDE.md` / `TROUBLESHOOTING.md` — install steps / general troubleshooting.
- `decisions/` — **`BASELINE.md` is the single current-truth for decisions**, plus 14 consolidated ADRs and `ADR-MAPPING.md` (old ADRs 001–046 live only in git tag `adr-legacy-2026-06-22`).
- `runbooks/` — per-scenario operational response guides.
- `reviews/` — code-review / cross-review outputs.
- `reference/` — current per-component v2 design reference (7 files + README); **one file per component is the single source of truth**. (The old `superpowers/reference/` was a stale orphan left after this moved out — it has been deleted.)
- `superpowers/plans/` / `superpowers/specs/` — planning/design docs. **Single canonical location as of 2026-07-01** (the top-level `docs/plans/` and `docs/specs/` were consolidated here) — flag a new PR that recreates a top-level `docs/plans/` or `docs/specs/` file.
- `superpowers/archive/` — historical specs/plans, superseded by `reference/` (do not treat as current).

### Conventions a reviewer must enforce
- **All new docs are bilingual** (Korean + English).
- **ADR filename format:** `NNN-kebab-case-title.md`. New ADR number = highest existing number + 1 (monotonic; no gaps, no reuse), and **BASELINE.md must be updated in the same PR**.
- Runbooks must follow `docs/runbooks/CLAUDE.md` rules.
- Design content belongs in `reference/` (one component = one file). When updating a component's design, edit its reference file rather than adding parallel/duplicate docs or reviving archived ones.

### Boundaries / gotchas
- `reference/` is authoritative; `archive/` is dead history — flag any change that edits archive as if current, or that splits a component's design across multiple reference files.
- This is a docs tree only — no application logic. Watch for accidental secrets/credentials in committed docs (account IDs, ARNs, domains, tokens) and reject them.

### v1 vs v2 scope note
The repo runs a legacy v1 app (`src/`, CDK/EC2) in parallel with the current v2 architecture (`web/`, `terraform/v2/`). Docs may cover either; when reviewing design references, confirm which line a doc targets so v1 rules aren't applied to v2 (or vice versa).
