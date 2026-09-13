---
name: sync-docs
description: Use when aligning AWSops developer or reviewer documentation with current code
triggers: sync docs, documentation update
---

# Sync Documentation

Read root `CLAUDE.md` and `docs/decisions/BASELINE.md`. Establish the user's file
ownership and requested scope before editing.

1. Inspect actual source, package scripts, Make targets, tests, and gate wiring.
   Record contradictions with file evidence.
2. Write concise English guidance. Scoped context should link to root policy and
   describe local boundaries and non-obvious contracts. Link to registries rather
   than copying route/tool counts, model versions, or release history.
3. Preserve FROZEN/GATED distinctions and accepted compatibility paths. A docs
   cleanup cannot change product policy or application i18n.
4. Edit canonical scoped `CLAUDE.md` first, then use the installed co-agent plugin's
   `/co-agent sync-context` for that module to distill `AGENTS.md`, regenerate its
   marker, and validate it. The command and validator come from the plugin, not
   repository scripts. Kiro's project-context steering includes `AGENTS.md`.
5. Check links, commands, generated markers, and the diff. Report changes,
   remaining contradictions, and validation. Leave other owners' files intact.

Changelog guidance is English-only; retain one entry per feature/category without
requiring translation parity or new bullets for each review round.
