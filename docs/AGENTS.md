<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 72f7d76a5666 · generated-at: 2026-08-26 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Documentation — Reviewer Context

Project docs organized by purpose; each subdirectory has its own `CLAUDE.md`.
`decisions/BASELINE.md` is the decision single source of truth (+ consolidated ADRs 001–020).
`reference/` is current v2 design, one file per component. `plans/`, `superpowers/plans|specs`,
and `history/` mix current, frozen, and superseded material — never treat them as live guidance
on their own; anything about mutation/autonomy is settled by ADR-005 FROZEN regardless of what
an old plan says.

## Conventions
- New documents are bilingual Korean/English, with two exceptions: **all `CLAUDE.md`-type files
  are English-only regardless of directory** (they're context files Claude Code auto-loads —
  the goal is context-size savings), and implementation-facing design specs under
  `docs/superpowers/specs/` are English-only. "Stays bilingual" is about a directory's body
  content, never its `CLAUDE.md`.
- New ADR = consolidated-ADR highest number + 1 (currently 020); update `BASELINE.md` in the
  same PR.
- Don't mix current truth (`decisions/BASELINE.md` + `reference/`) with old plans/history when
  citing what's live.

## Review checklist
1. A CLAUDE.md-type file added in Korean (or bilingual) anywhere in the repo is a convention
   violation — flag it.
2. A new ADR without a same-PR `BASELINE.md` update is "not live" (anti-drift) — flag it.
3. Content sourced from `superpowers/plans|specs` or `history/` cited as current behavior
   should be cross-checked against `decisions/BASELINE.md` before trusting it.

## Known false-positives
- `docs/plans/`, `docs/superpowers/plans|specs`, and `docs/history/` containing frozen-era or
  superseded material is expected — that's their purpose, not drift to clean up.
