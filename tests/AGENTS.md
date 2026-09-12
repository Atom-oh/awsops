<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: c447782b7532 · generated-at: 2026-09-12 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Tests Module — Reviewer Context

Bash hook/structure tests validate repo tooling contracts, separate from web vitest and
agent pytest/unittest. The full runner includes offline PR-review and agent tests.
PR-review fixtures use fake CLIs to cover all 12 nonce-bound JSON report frames, strict
schema/final-line checks, quoted/plain/fenced tool strings and static marker examples,
numeric Kiro footers, rejected unframed chatter, retries/hard kills and chair CLI failures.
Earlier other-nonce frames are opaque chatter; only the current report is delivered.
Wrong-nonce-only, trailing other-nonce, same-nonce wrong-lens and duplicate expected-nonce
frames fail closed.
Historical captured L2/L4 bodies are roundtrip inputs, not current review approval.
All 12 decoded reports must reach the chair without chatter or truncation. Cell scrubber
failure and decoded token redaction have behavioral tests; chair scrubber PID capture/wait
is structural, without an injected chair-scrubber failure fixture.
Pod Identity preflight tests preserve provider/signing settings and leave `GITHUB_ENV`
untouched. Fixtures record only selected non-secret settings, never the full environment.

## Build · Test
```bash
bash tests/run-all.sh    # hooks + structure + offline PR review + agent, TAP v13 output
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v  # offline PR review only
```

## Rules
- Output is TAP v13 (`ok N - desc` / `not ok N - desc`).
- A new hook needs a matching `tests/hooks/test-<hook>.sh`.
- Secret-detection tests add positives to `tests/fixtures/secret-samples.txt`, negatives to
  `false-positives.txt`.
- Integration tests must use fixtures/mocks — never call live AWS/AI/Steampipe/AgentCore.
- Fixtures record only selected non-secret settings; never dump the full environment.
- Never bypass a failing CI hook (`--no-verify` is forbidden); fix the root cause.

## Review checklist
1. A new `.claude/hooks/` script ships with a corresponding test file.
2. Secret-pattern changes update both the positive and false-positive fixture files.
3. PR-review regressions exercise completion/failure behavior with fake CLIs.
4. No test reaches live AWS/AI/Steampipe/AgentCore or dumps the full environment.
