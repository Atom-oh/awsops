# Test coverage planning

The old v1 plan's zero-test baseline, deleted source paths, and estimated coverage
are historical and remain in git history. v2 already has Vitest, Python, shell,
and disposable-database tests. No measured line-coverage percentage is asserted here.

Use [merge verification](../v2-merge-verification.md) for current runners and CI
boundaries. Inspect existing tests before identifying a gap; test names, counts,
and fixture success alone do not establish production coverage.

## Select checks by changed contract

| Area | Existing evidence and review focus |
| --- | --- |
| Authentication and ownership | `web/lib/auth.test.ts`, route tests: signature/claims, revocation, admin checks and requester scope |
| Data and migrations | `web/lib/jobs.test.ts`, `scripts/v2/*.itest.mjs`: parameter binding, idempotency, immutable migrations and real PostgreSQL transitions |
| Routing and tools | `web/lib/route.test.ts`, `merge-invariants.test.ts`, `agent/test_agent.py`: routing order, aliases, tool gates and fallback behavior |
| Collection and diagnosis | Source/graph tests and `scripts/v2/workers/diagnosis/test_*.py`: observed zero versus missing/partial evidence, producer shapes and unassessed verdicts |
| UI | Colocated component/page tests: loading, errors, scoped evidence, accessibility and app translations |
| Infrastructure and review tooling | `scripts/v2/test_merge_invariants.py`, `tests/structure/`, `scripts/pr-review/test_*.py`: gates, trust boundaries, required review coverage and failure handling |

Check schema plus migrations when testing data contracts. Aurora parameter bindings
are expected; legacy bans on `$` in SQL are not v2 requirements. Preserve the
intentional disabled live-Steampipe chat/collector paths and frozen mutation gates.

## Execution and reporting

From the repository root:

```bash
(cd web && npx vitest run)
bash scripts/v2/merge-verify.sh
bash tests/run-all.sh
```

The merge runner executes Python files in isolated processes. Database integration
tests need disposable Docker PostgreSQL and run separately with Node. Production
build validation is `npm run build` from `web/`. Live routing/model checks require
explicit selection and actual results; they are separate from offline tests.

Report failing and skipped checks, relevant missing scenarios, and evidence needed
to close each gap. Keep current semantic assertions intact; a documentation cleanup
does not authorize weakening tests or replacing them with formatting checks.
