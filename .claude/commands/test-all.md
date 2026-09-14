# Run Validation

Use root `CLAUDE.md` and the current workflow for required checks. From the
repository root:

```bash
bash scripts/v2/merge-verify.sh
bash tests/run-all.sh
```

The first runner isolates Python test files, runs web Vitest, and reports
Terraform checks. Its Terraform warnings/skips are non-blocking, so exit zero
does not prove Terraform validation succeeded. For infrastructure changes,
validate the initialized `terraform/v2/foundation/` explicitly.

The second runner covers hooks, structure, offline PR-review tooling, and agent
tests. Production web validation is `npm ci && npm run build` in `web/`.
Report PASS, FAIL, and SKIP accurately, with the failing command and reason.
