<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: a09a3aee630b · generated-at: 2026-08-26 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Tests Module — Reviewer Context

Bash-based structure/hook test suite, separate from the app's own tests (`web/`'s vitest,
`agent/`'s pytest/unittest). Validates repo-wide tooling/structure contracts: `.claude/hooks/`
behavior and secret patterns (`tests/hooks/test-*.sh`), and agent contracts / PR review
workflow / Steampipe-ExternalId terraform wiring (`tests/structure/test-*.sh`).

## Build · Test
```bash
bash tests/run-all.sh    # everything: hooks + structure + agent unittest, TAP v13 output
```

## Rules
- Output is TAP v13 (`ok N - desc` / `not ok N - desc`).
- A new hook needs a matching `tests/hooks/test-<hook>.sh`.
- Secret-detection tests add positives to `tests/fixtures/secret-samples.txt`, negatives to
  `false-positives.txt`.
- Integration tests must use fixtures/mocks — never touch real Steampipe/AgentCore.
- Never bypass a failing CI hook (`--no-verify` is forbidden); fix the root cause.

## Review checklist
1. A new `.claude/hooks/` script ships with a corresponding test file.
2. Secret-pattern changes update both the positive and false-positive fixture files.
3. No test reaches out to live AWS/Steampipe/AgentCore.
