# Repository Tests

Read root [CLAUDE.md](../CLAUDE.md) and
[BASELINE.md](../docs/decisions/BASELINE.md) for policy. These tests cover repo
hooks, structure, and review tooling; web Vitest and agent/worker pytest have
separate entry points.

From the repository root:

```bash
bash tests/run-all.sh
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
```

`run-all.sh` also invokes agent tests. Inspect its output and child exit codes;
some historical shell assertions are advisory. A skipped check is not a pass.

- Hook contracts live in `hooks/test-*.sh`; structure contracts in
  `structure/test-*.sh`. New hooks need matching tests. Keep TAP-style output.
- Secret-pattern tests need positive and false-positive fixtures. Fixtures may
  record selected non-secret settings, never the full environment.
- Review tooling uses fake CLIs for completion/failure, nonce-bound framing,
  required coverage, retries, redaction, and ambient credential preflight.
  Read `scripts/pr-review/test_*.py` for current cases; historical captured review
  reports are roundtrip inputs, not approval or evidence about current code.
  `structure/test-pr-review-panel.sh` drives `run-panel.sh` with stubbed CLIs for
  the read-only Kiro agent, preflight, quota and agent-fallback paths.
- Tests here remain offline: use fixtures/mocks, not live AWS/AI/AgentCore calls.
  Do not disable required checks or bypass hooks to obtain a passing result.
