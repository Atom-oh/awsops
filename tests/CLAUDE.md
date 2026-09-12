# Tests Module

## Role
Bash-based structure/hook test suite. Separate from the v2 app's own tests — `web/`'s vitest,
`agent/`'s pytest/unittest — this validates repo-wide tooling/structure contracts.

## Layout
| Path | Covers | Runner |
|------|--------|--------|
| `tests/hooks/test-*.sh` | `.claude/hooks/` hook script behavior, secret patterns | `bash tests/run-all.sh` |
| `tests/structure/test-*.sh` | Agent contracts, PR review workflow, Steampipe/ExternalId terraform wiring | `bash tests/run-all.sh` |
| `tests/fixtures/` | Secret samples, false-positive samples | Loaded by hook/secret tests |
| `scripts/pr-review/test_*.py` | Offline fake-CLI review completion, all 12 reports, retries/hard kills, token redaction and Pod Identity preflight | `bash tests/run-all.sh` or `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v` |

`tests/run-all.sh` also drives `agent/`'s Python unittest (dark-path loop, account logic, etc.)
alongside the hook/structure tests above.
The PR-review tests verify that preflight preserves the ambient provider/signing settings,
requires a valid Pod Identity session, and leaves `GITHUB_ENV` untouched.
Fixtures record only selected non-secret settings, never the full subprocess environment.
Completion fixtures cover one final nonce-bound JSON report frame, strict schema and
physical-line boundaries, quoted/plain/fenced tool strings and static marker examples,
numeric Kiro footers, and rejected generic/concatenated chatter without a valid frame.
Other-nonce source examples before the current frame are ignored as chatter; only the
current report reaches the chair. Wrong-nonce-only, trailing other-nonce, same-nonce
wrong-lens and duplicate expected-nonce cases remain rejected.
Captured L2/L4 report bodies are historical roundtrip inputs, not approval of current code.
The fake matrix checks all 12 decoded reports reach the chair without chatter or truncation.
Cell scrubber failures, chair CLI failures and decoded token redaction are tested behaviorally;
chair scrubber PID capture/wait is checked structurally, without a chair-scrubber failure fixture.

## Running
```bash
bash tests/run-all.sh    # everything (TAP format: hooks + structure + PR review + agent)
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v  # offline PR review only
```

## Rules
- Output is TAP v13 — `ok N - desc` / `not ok N - desc`.
- Adding a new hook requires a matching test file under `tests/hooks/` (`test-<hook>.sh`).
- Secret-detection tests: add positive cases to `tests/fixtures/secret-samples.txt`, negative
  cases to `false-positives.txt`.
- Integration tests must never call live AWS/AI/Steampipe/AgentCore — use fixtures/mocks.
- Fixtures may record only selected non-secret settings; never dump the full environment.
- Never bypass a failing CI hook (`--no-verify` is forbidden) — fix the root cause.
