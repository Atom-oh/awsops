# Code Review

Review the requested diff using `.claude/skills/code-review/SKILL.md`.
Read root `CLAUDE.md`, `AGENTS.md`, `docs/decisions/BASELINE.md`, and relevant
scoped context first.

For a working-tree review, inspect staged and unstaged changes and relevant
untracked files. For a PR, identify the base and latest HEAD before reviewing.
Trace each suspected issue through the implementation and tests.

Report findings in English with severity, changed file/line, trigger, impact, and
a concrete fix. Record incomplete checks and pre-existing contradictions
separately. A review-only request does not authorize edits or merge.
