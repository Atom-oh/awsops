# v2 Merge Verification

This gate turns the v2 merge invariants from the design audit into executable checks before merging
`feat/v2-architecture-design` to `main`.

## Scenarios

| Scenario | Invariant | Design source | Verification code path | Command |
| --- | --- | --- | --- | --- |
| S1 | Frozen and gated Terraform resources stay default-off, gated by `count` or `for_each`, and tracked tfvars do not enable gated flags. | `docs/decisions/BASELINE.md`, ADR-005, ADR-006, ADR-007 | `scripts/v2/test_merge_invariants.py`, `scripts/v2/merge_invariants.py` | `python3 -m pytest scripts/v2/test_merge_invariants.py -q` |
| S2 | The 9 routed sections align across AgentCore catalog, web sections, route rules, and the `observability` to `external-obs` alias; v1 `/awsops/` route literals do not leak into v2 web sources. | ADR-004, ADR-038 | `web/lib/merge-invariants.test.ts`, `web/lib/merge-invariants.ts` | `cd web && npx vitest run lib/merge-invariants.test.ts` |
| S3 | Merge verification runs the isolated Python suite, web vitest, opportunistic Terraform checks, and the PR CI gate. | 2026-07-05 v2 merge verification plan | `scripts/v2/merge-verify.sh`, `.github/workflows/merge-verify.yml` | `bash scripts/v2/merge-verify.sh` |

## Runner Usage

Run the full merge verification from the repository root:

```bash
bash scripts/v2/merge-verify.sh
```

The runner discovers `test_*.py` under `scripts/v2` and `agent` by default, then runs each file in a
separate `python3 -m pytest` process from the file's own directory. Files in a `tests/` directory get
that directory's parent prepended to `PYTHONPATH` for that one pytest process, so adjacent module-root
imports such as `agent/anthropic_loop.py` resolve while failure summaries still use the original
discovered path. Override the Python search root for focused checks:

```bash
MERGE_VERIFY_PY_ROOT=/tmp/merge-fixtures MERGE_VERIFY_SKIP_WEB=1 bash scripts/v2/merge-verify.sh
```

Set `MERGE_VERIFY_SKIP_WEB=1` only for local fixture or runner development. The CI workflow runs the
web vitest stage.

The Terraform stage runs `terraform -chdir=terraform/v2/foundation fmt -check` when the binary is
available, and also runs `validate` when `terraform/v2/foundation/.terraform` exists. Missing
Terraform tooling is reported as `SKIP`; Terraform diagnostics are non-blocking in this runner.

## Pytest Isolation

Do not replace the Python stage with a single aggregate `pytest scripts/v2 agent` command. The current
suite has known false positives when files share one Python process: tests mutate `sys.path` and
environment variables, and same-name helper modules such as `db` and `handlers` can collide. Running
each `test_*.py` file in its own pytest process preserves isolation and avoids the measured 57
aggregate-run false failures.

## CI Gate

`.github/workflows/merge-verify.yml` runs on pull requests targeting `main`. It checks out the PR,
sets up Node.js 20 and Python 3.12, installs web dependencies with `cd web && npm ci`, installs
`pytest` plus the v2 Python subsystem requirements, and executes `bash scripts/v2/merge-verify.sh`.

## Manual Gates Outside CI

Before the final merge, run the routing accuracy gate against real Bedrock:

```bash
node scripts/v2/routing-accuracy.mjs
```

This is the ADR-038 golden-set check and must remain at or above 85%.

Also run the production web build manually:

```bash
cd web && npm run build
```
