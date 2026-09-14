<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 11995d0b7940 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> Reviewer context distilled from this module’s CLAUDE.md; shared by Kiro, Codex, and Agy.

# Repository Test Review

Use root [CLAUDE.md](../CLAUDE.md) and
[BASELINE.md](../docs/decisions/BASELINE.md) for policy.

```bash
bash tests/run-all.sh
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
```

Run from the repository root. The full runner covers hooks, structure, offline
PR-review tooling, and agent tests. Inspect child failures/skips; some historical
shell assertions remain advisory.

- New hooks need matching tests. Preserve TAP-style reporting and required checks.
- Secret patterns need positive and false-positive fixtures. Record selected
  non-secret settings only; never capture a full environment.
- Keep these tests offline using fixtures/fake CLIs. Preserve completion,
  nonce-bound framing, required coverage, retry, redaction, and ambient-provider
  contracts in `scripts/pr-review/test_*.py`.
- Captured historical review reports are test inputs, not current findings or
  approval. Do not bypass a failing hook or count a skipped check as a pass.
