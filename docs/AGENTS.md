<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: f1a96df2de8d · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> Reviewer context distilled from CLAUDE.md; shared across AI reviewers.

# Documentation review

New/rewritten developer/reviewer docs are English-only. Existing bilingual bodies
are a migration backlog; convert whole maintained documents while retaining facts.
Keep multilingual docs-site user guides
and app translations. Historical records retain their language/evidence.

Current decisions: `decisions/BASELINE.md` plus consolidated `NNN-*.md` ADRs.
Current implementation references: `architecture.md`, `reference/`, `runbooks/`.
Plans/specs/review records under `plans/`, `specs/`, `reviews/`, `superpowers/` and
`history/` do not authorize features or prove deployment. In particular,
`superpowers/reference/` is not the maintained `reference/` tree.

Verify paths and commands against this checkout. Source/migrations/tests establish
behavior; accepted decisions establish allowed behavior. Resolve contradictions
with evidence, not a silent policy reversal. New ADRs update BASELINE; use
ADR-MAPPING.md for legacy references. Do not invent required README sections,
bilingual parity, counts, or a new changelog bullet for an already covered feature.

Keep contexts concise and regenerate AGENTS after its CLAUDE source changes.
Do not commit credentials; use placeholders in examples. Account IDs/ARNs are
identifiers, not automatically credentials. Navigation: `README.md`.
