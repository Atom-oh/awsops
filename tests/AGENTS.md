<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: fa4f51b7859e · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

## tests/ — Test Suite

The project test suite. Two parallel tiers:
- **Bash structure/hook tests** (`tests/hooks/test-*.sh`, `tests/structure/test-*.sh`) — exercise `.claude/hooks/` scripts (behavior + secret-pattern detection) and agent/plugin structure contracts. Run via `bash tests/run-all.sh`.
- **TypeScript unit tests** (`tests/unit/*.test.ts`) — cover `src/lib/` alert logic (correlation, knowledge, types, webhook) and CDK alert infra. Run via `npm test` (ts-node / jest).
- **`tests/fixtures/`** — secret samples and false-positive samples, loaded by the hook/secret tests.

## Conventions a reviewer must enforce
- **Output is TAP v13** — `ok N - desc` / `not ok N - desc`. New bash tests must conform.
- **1:1 mapping** — a unit test is named `<module>.test.ts` and maps to `src/lib/<module>.ts`.
- **New hook ⇒ new test** — adding a hook requires a matching `tests/hooks/test-<hook>.sh`.
- **Secret-detection cases** — positives go in `tests/fixtures/secret-samples.txt`, negatives in `false-positives.txt`. Use real-looking-but-fake samples only.

## Banned patterns / gotchas
- **No live external deps in integration tests** — never connect to real Steampipe or AgentCore; use fixtures/mocks.
- **Never bypass a failing CI hook** — `--no-verify` is banned; fix the root cause instead.

## Scope note
This directory targets the **v1 codebase** (`src/lib/`, CDK alert infra, `.claude/hooks/`). It is distinct from v2 (`web/`, `terraform/v2/`), which carries its own colocated tests (`*.test.ts(x)` beside sources, run from `web/`). Don't conflate the two when reviewing.
