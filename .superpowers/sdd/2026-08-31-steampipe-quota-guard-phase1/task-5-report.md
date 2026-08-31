# Task 5 Report — ADR-021 and Phase 1 Verification

## Status

Completed the original documentation-only Task 5. The agent executing that task did not run Terraform apply or AWS mutation and did not relax ADR-005; controller deployment status was not established by that evidence.

Commit: `007dc89c docs: adopt quota-isolated inventory collection`

## Files

Committed:

- `docs/decisions/021-quota-isolated-inventory-reads.md`
- `docs/decisions/BASELINE.md`
- `docs/decisions/001-v2-foundation.md`
- `docs/decisions/010-inventory-resource-model.md`
- `docs/reference/03-data-aurora.md`
- `docs/reference/05-agentcore.md`
- `docs/runbooks/steampipe-quota-and-staleness.md`

The ADR and runbook are bilingual. Fix Round 1 below corrects the original over-broad current-truth wording: the limited ops `inventory-read-target` already coexists with direct domain targets, while Phase 2 expands Aurora coverage and retires those direct targets. Aurora-only is not live.

## Verification

| Command | Result |
|---|---|
| `rg -n 'T[B]D|T[O]DO|PLACEHOLDER' docs/decisions/021-quota-isolated-inventory-reads.md docs/runbooks/steampipe-quota-and-staleness.md` | No matches |
| `git diff --check` | Passed |
| `bash tests/structure/test-steampipe-fanout.sh` | Passed; checked limiter variables/defaults, limiter env wiring, reserved concurrency, 900-second event expiry, zero async retries, and related guardrails |
| `python3 -m pytest scripts/v2/steampipe/test_spc_render.py scripts/v2/steampipe/test_sync_lambda_queries.py scripts/v2/steampipe/test_sync_inventory_additions.py -q` | Passed: 56 tests. 22 Python 3.9/Boto3 deprecation warnings only |
| `cd web && npx vitest run lib/inventory.test.ts app/api/inventory/'[type]'/refresh/route.test.ts app/api/security/refresh/route.test.ts` | Passed: 3 files, 17 tests. Vite CJS deprecation warning only |
| `terraform -chdir=terraform/v2/foundation fmt -check` | Not clean: reports pre-existing formatting in unchanged `data.tf` and `workers.tf`. This Task 5 diff contains no `.tf` files; scoped changed-file Terraform check is therefore empty. |
| `terraform -chdir=terraform/v2/foundation validate` | Blocked by unavailable/corrupted local provider packages: AWS 6.47.0, random 3.9.0, archive 2.8.0 are absent from `.terraform/providers`. No initialization/download or apply was attempted. |

## Self-review

- ADR-021 records why read-only control-plane APIs can affect availability, the selected quota-limited Steampipe→Aurora→domain-MCP target, bounded CloudWatch Metrics/Logs end-state exception, exact Phase 1 defaults, and no silent stale/unavailable fallback.
- The rollout table distinguishes Phase 1 code implementation from unimplemented/un-deployed Phases 2 and 3.
- The runbook covers variables/defaults, generated `aws.spc` inspection, lifecycle log event names, stale inventory identification, safe tuning, non-destructive rollback, and the required deployment order.
- No document enables mutation, autonomy, BYO-MCP, or any ADR-005 exception.

## Concerns

- Terraform `fmt -check` is not repository-clean because of unchanged `data.tf` and `workers.tf`.
- Terraform `validate` could not run in this environment because the required provider packages are unavailable.

---

## Fix Round 1

### Status

Implemented the missing load-bearing runtime/Terraform contracts and corrected the documentation.
The agent performing this fix round did not run Terraform apply, AWS mutation, or any ADR-005
capability change. Controller deployment status must be verified separately.

Commit: `48e5384f fix: complete steampipe quota guard contracts`

### RED evidence

- Inventory reader freshness tests failed because `query_inventory` had no `freshness`, summary SQL
  had no bound threshold, and `_inventory_stale_after_minutes` did not exist.
- Limiter telemetry test failed because `_render_spc` emitted no
  `steampipe_limiter_config` JSON event.
- Sync terminal tests failed because `degraded`, `throttled`, success `freshness`, and
  `age_minutes` were absent.
- Structure test failed because `inventory_stale_after_minutes` and
  `INVENTORY_STALE_AFTER_MINUTES` wiring did not exist.

### GREEN evidence

| Command | Result |
|---|---|
| Focused inventory-reader freshness tests | Passed: 3 tests |
| Focused limiter-config log test | Passed: 1 test |
| Focused terminal-state/redaction tests | Passed: 7 tests |
| `python3 -m pytest scripts/v2/steampipe -q` | Passed: 61 tests; 23 Python 3.9/Boto3 deprecation warnings |
| `python3 -m pytest agent/lambda/test_inventory_read_mcp.py -q` | Passed: 29 tests |
| `bash tests/structure/test-steampipe-fanout.sh` | Passed: all wiring checks, including stale variable/env |
| Focused web Vitest command from Task 5 | Passed: 3 files, 17 tests; Vite CJS warning only |
| `terraform fmt -check terraform/v2/foundation/ai.tf terraform/v2/foundation/variables.tf` | Passed after scoped formatting |
| `terraform -chdir=terraform/v2/foundation validate` | Blocked: cached `archive 2.8.0`, `aws 6.47.0`, and `random 3.9.0` provider packages are missing/corrupted |
| Placeholder scan, `git diff --check`, and `docs/reference` ADR-link check | Passed |

### Files

- Runtime/tests: `agent/lambda/inventory_read_mcp.py`,
  `agent/lambda/test_inventory_read_mcp.py`, `scripts/v2/steampipe/sync_lambda.py`,
  `scripts/v2/steampipe/gen_spc_entrypoint.py`, and their Steampipe tests.
- Terraform/structure: `terraform/v2/foundation/{variables.tf,ai.tf,terraform.tfvars.example}`
  and `tests/structure/test-steampipe-fanout.sh`.
- Current truth/runbook: ADR-001, ADR-010, ADR-021, BASELINE, data/AgentCore references,
  all corrected `docs/reference` ADR links, and the Steampipe quota/staleness runbook.

### Self-review

- `inventory_stale_after_minutes` defaults to 30 and validates integer `1..1440`; malformed runtime
  env values safely fall back to 30 without exposing or consuming secrets.
- `query_inventory` and `inventory_summary` disclose per-type
  `healthy|stale|unavailable`, latest-success time, age, and threshold. Resource type and threshold
  are Data API bound parameters; no user value is interpolated into SQL.
- Every normal sync terminal event carries `degraded` and `throttled`; successful completion also
  carries `freshness=healthy` and `age_minutes=0`. Throttling detection uses structured exception
  code/class metadata and logs no raw exception text.
- `steampipe_limiter_config` contains only effective non-secret limiter values. The runbook uses
  CloudWatch Logs inspection and does not enable ECS Exec.
- The limited ops `inventory-read-target` is documented as already coexisting with direct domain
  targets. Phase 2 expands domain-aware Aurora coverage and retires direct inventory/config targets;
  Aurora-only is not described as live.
- Read-only posture, existing return contracts, secret boundaries, and ADR-005 FROZEN remain intact.

### Concerns

- Terraform validation still requires a controller/environment with intact provider packages.
- Python 3.9 emits the existing Boto3 end-of-support warning; production Lambda runtimes remain
  Python 3.11/3.12 as configured.

---

## Fix Round 2

### Status

Implemented durable inventory freshness semantics without editing the frozen
`terraform/v2/foundation/data/schema.sql`. No Terraform apply, AWS mutation, or ADR-005 capability
change was performed.

The additive ULID migration
`01M1B3NB288P56BDR1GMEN9GH9_inventory_sync_freshness.sql` adds durable
`last_success_at`/`last_success_row_count`, permits `partial`, backfills existing succeeded rows,
and recreates the explicit-column `sql_reader.inventory_sync_runs` view without exposing `error`.

### RED evidence

- An expected target account omitted from the aggregate result and failing its own data-path probe
  still returned/logged `succeeded` and `healthy`.
- A genuine zero-row success did not write durable success metadata, so a later failure left no
  success timestamp in either the singleton ledger or resource rows.
- Reader SQL used current `finished_at` or `MAX(captured_at)`, allowing newer rows/current attempts
  to hide preserved older rows.
- Migration/view-contract tests failed because no additive durable-freshness migration existed.

### GREEN evidence

| Command | Result |
|---|---|
| Focused partial-account + zero-row durability sync tests | Passed: 2 tests |
| Focused partial/stale/zero-row reader and migration tests | Passed |
| `python3 -m pytest scripts/v2/steampipe -q` | Passed: 67 tests; 26 existing Python 3.9/Boto3 warnings |
| `PYTHONPATH=agent/lambda python3 -m pytest agent/lambda/test_inventory_read_mcp.py agent/lambda/test_inventory_view_contract.py -q` | Passed: 40 tests |
| `PYTHONPATH=agent/lambda python3 -m pytest scripts/v2/steampipe/test_inventory_freshness_migration.py agent/lambda/test_inventory_view_contract.py -q` | Passed: 12 tests |
| `bash tests/structure/test-steampipe-fanout.sh` | Passed |
| Focused web Vitest: inventory, refresh routes, migration core | Passed: 4 files, 33 tests; existing Vite CJS warning only |
| `node scripts/v2/migrate.mjs --status` | Passed; recognizes 52 valid migration files including the new ULID |
| `DRY_RUN=1 OFFLINE=1 node scripts/v2/migrate.mjs` + new-migration field scan | Passed; offline runner emits the new migration and both durable fields |
| Placeholder/stale-wording scans and `git diff --check` | Passed |
| `terraform fmt -check terraform/v2/foundation/steampipe.tf terraform/v2/foundation/ai.tf terraform/v2/foundation/variables.tf` | Passed |
| `terraform -chdir=terraform/v2/foundation validate` | Blocked as expected: cached AWS 6.47.0, random 3.9.0, and archive 2.8.0 provider packages are missing/corrupted |

### Semantics

- The sync tracks the expected host plus enabled in-scope target accounts. Accounts contributing
  rows are reachable; zero-row accounts must pass their own Steampipe connection probe.
- Any unreachable expected aggregator account preserves its last-good rows, records current
  `status='partial'`, returns `status=partial`, and emits `inventory_sync_complete` with
  `degraded=true`, `freshness=degraded`, `age_minutes=null`, and only
  `unreachable_account_count`. Account IDs are not logged.
- Running, failed, and partial attempts preserve durable last-success fields. Full success updates
  them, including a genuine zero-row run after every expected account proves reachable.
- If advisory-unlock cleanup fails after work completed, the ledger is changed to failed and its
  prior durable last-success values are restored before the Aurora connection is closed.
- Reader freshness uses the oldest current `captured_at` where rows exist, otherwise durable
  `last_success_at`. Stale age takes precedence; recent partial/failed/running data is `degraded`;
  only recent current `succeeded` data is `healthy`; no success/data is `unavailable`.
- `query_inventory` and `inventory_summary` disclose current status, durable last-success metadata,
  oldest current capture, effective timestamp, age, threshold, and freshness.
- ADR-010 no longer claims the shipped `ecs_service` sync is missing. ADR-001/010/021, BASELINE,
  Aurora/AgentCore references, and the operator runbook now describe the durable semantics.

### Concerns

- The controller must initialize intact Terraform providers and run `terraform validate` after this
  commit.
- A disposable PostgreSQL execution check was not available because the sandbox cannot access
  `/var/run/docker.sock`; migration static contracts and both offline runner checks passed.

---

## Fix Round 3

### Status

Eliminated premature terminal ledger writes on the main Aurora work connection. The main connection
now writes only the `running` state and inventory/snapshot work. After advisory unlock and main
close complete, a fresh short-lived Aurora connection finalizes exactly one of
`succeeded|partial|failed`.

No Terraform apply, AWS mutation, schema change, or ADR-005 capability change was performed.

### RED evidence

Command:

```bash
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py -q
```

Result before the production change:

```text
9 failed, 18 passed in 0.21s
```

The failures proved that the old implementation:

- opened only the main Aurora connection,
- issued succeeded/partial/failed updates on that main connection,
- could leave a fresh succeeded ledger after main close made the connection unusable,
- did not surface a fresh-finalizer write failure, and
- had no best-effort finalizer-close behavior to verify.

### GREEN evidence

| Command | Result |
|---|---|
| `python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py -q` | Passed: 27 tests |
| `python3 -m pytest scripts/v2/steampipe -q` | Passed: 69 tests; 28 existing Python 3.9/Boto3 warnings |
| `PYTHONPATH=agent/lambda python3 -m pytest agent/lambda/test_inventory_read_mcp.py agent/lambda/test_inventory_view_contract.py -q` | Passed: 40 tests |
| `PYTHONPATH=agent/lambda python3 -m pytest scripts/v2/steampipe/test_inventory_freshness_migration.py agent/lambda/test_inventory_view_contract.py -q` | Passed: 12 tests |
| `cd web && npx vitest run lib/inventory.test.ts app/api/inventory/'[type]'/route.test.ts app/api/inventory/summary/route.test.ts` | Passed: 3 files, 22 tests; existing Vite CJS warning only |
| `python3 -m py_compile scripts/v2/steampipe/sync_lambda.py scripts/v2/steampipe/test_sync_lambda_queries.py` | Passed |
| `git diff --check` | Passed |

### Semantics

- Full success, including a genuine zero-row result, is finalized only on the fresh connection and
  advances `last_success_at` plus `last_success_row_count`.
- Partial completion is finalized only on the fresh connection and does not modify durable
  last-success fields.
- Work failure is finalized only on the fresh connection and does not modify durable last-success
  fields.
- Unlock or main-close failure overrides any pending outcome to `failed`; the fresh connection
  writes that failure without advancing last-success.
- A realistic close-failure regression makes the main connection unusable, proves that no terminal
  update was issued there, and verifies that the fresh finalizer records `failed`.
- If finalizer connect/write fails, the caller emits one redacted failed terminal result while the
  durable row remains `running` with its previous last-success fields; no false healthy success was
  written.
- Once a finalizer update succeeds, an error while closing that short-lived connection is
  best-effort and does not downgrade the committed ledger state.
- Existing single-terminal-log, redaction, throttling classification, and `BaseException`
  re-raise/no-terminal-log behavior remain covered.

### Concerns

- Every locked sync now opens one additional short-lived Aurora connection for terminal
  finalization. This is the controller-approved reliability tradeoff.
- A finalizer outage intentionally leaves the current row `running`; reader freshness remains based
  on the previous durable success and classifies the current state as degraded rather than falsely
  healthy.

---

## Fix Round 4

### Status

Closed the post-unlock stale-finalizer race with per-run compare-and-set ownership. Each allowed
sync invocation generates a UUID-hex `run_token`, stores it in the singleton running ledger row,
and passes it to the fresh-connection finalizer. Succeeded, partial, and failed terminal updates
all require the same token and use `RETURNING 1`.

A zero-row result is now a safe `superseded` failure: the stale invocation does not modify the
newer row and emits one redacted degraded terminal record without token or account identifiers.
The existing freshness migration was amended in place; no second migration or `schema.sql` edit was
made. No Terraform apply, AWS mutation, or ADR-005 capability change was performed.

### RED evidence

| Command | Result before production changes |
|---|---|
| `python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py -q` | Failed as intended: 6 failed, 26 passed. Missing token generation/finalizer argument, missing CAS predicate/`RETURNING`, and run A still returned success after overwriting run B. |
| `PYTHONPATH=agent/lambda python3 -m pytest scripts/v2/steampipe/test_inventory_freshness_migration.py agent/lambda/test_inventory_view_contract.py -q` | Failed as intended: 1 failed, 11 passed because the unmerged durability migration did not add `run_token`. |

### GREEN evidence

| Command | Result |
|---|---|
| `python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py -q` | Passed: 32 tests |
| `PYTHONPATH=agent/lambda python3 -m pytest scripts/v2/steampipe/test_inventory_freshness_migration.py agent/lambda/test_inventory_view_contract.py -q` | Passed: 12 tests |
| `python3 -m pytest scripts/v2/steampipe -q` | Passed: 74 tests; 33 existing Python 3.9/Boto3 warnings |
| `PYTHONPATH=agent/lambda python3 -m pytest agent/lambda/test_inventory_read_mcp.py agent/lambda/test_inventory_view_contract.py -q` | Passed: 40 tests |
| `cd agent && python3 -m pytest test_agent.py -q` | Passed: 55 tests |
| Focused inventory/migration Vitest (6 files) | Passed: 46 tests; existing Vite CJS warning only |
| `cd web && npx vitest run` | Passed: 231 files, 2260 tests; 1 live-routing test skipped; existing expected stderr fixtures and Vite CJS warning only |
| `bash tests/structure/test-steampipe-fanout.sh` | Passed |
| `node scripts/v2/migrate.mjs --status` | Passed; recognizes 52 valid migration files and still exactly one inventory-freshness ULID migration |
| `DRY_RUN=1 OFFLINE=1 node scripts/v2/migrate.mjs` field scan | Passed; emitted the amended migration with `run_token`, `last_success_at`, and `last_success_row_count` |
| Docs placeholder scan, ADR-link scan, `python3 -m py_compile ...`, and `git diff --check` | Passed |
| `terraform fmt -check terraform/v2/foundation/steampipe.tf terraform/v2/foundation/ai.tf terraform/v2/foundation/variables.tf` | Passed |
| `terraform -chdir=terraform/v2/foundation validate` | Blocked by the existing environment limitation: cached `archive 2.8.0`, `aws 6.47.0`, and `random 3.9.0` provider packages are missing/corrupted |

### Concurrency and durability semantics

- The running INSERT/UPSERT replaces `run_token` together with the current-run state while leaving
  durable last-success fields unchanged.
- Every fresh succeeded/partial/failed finalizer uses
  `WHERE resource_type=:t AND account_id='self' AND run_token=:run_token RETURNING 1`.
- The interleaving regression makes run B replace/finalize the row during run A's main-connection
  close. B retains its token, terminal status, and row count; A receives zero rows and returns/logs
  `error_category=superseded`.
- A normal matching-token finalizer returns exactly one row. More than one row is treated as an
  invariant/write failure; connection/write failures retain the prior safe failure behavior.
- Structured logs contain neither token value nor account IDs. The explicit-column
  `sql_reader.inventory_sync_runs` view exposes neither `run_token` nor `error`.
- Existing zero-row success, partial/unreachable-account preservation, cleanup-failure override,
  finalizer-close best effort, finalizer-write failure, and `BaseException` cleanup/re-raise
  semantics remain covered.

### Concerns

- The controller environment still needs intact Terraform provider packages for `terraform
  validate`; this agent did not initialize/download providers or run apply.
- Deployment must continue to run the amended migration before rolling the Lambda code, as the
  running UPSERT now requires the new internal column. Terraform owns/packages this Lambda;
  `make deploy` rolls only the web ECS service and does not satisfy the ordering requirement.

---

## Fix Round 5

### Status

Corrected the migration-before-Lambda rollout contract in the runbook, ADR-021, approved design,
Aurora reference, and Task 5 plan. No production code changed. No Terraform apply, AWS mutation,
service rollout, image push, or ADR-005 capability change was performed.

### Root cause and binding order

Terraform owns and packages `scripts/v2/steampipe/sync_lambda.py`, while the updated running UPSERT
requires the migration-owned `inventory_sync_runs.run_token` column. `make deploy` runs migrations
and rolls only the web ECS service, so it cannot order this Lambda deployment.

- Existing `steampipe_enabled=true`: build/push the new Steampipe image without rolling it →
  `make migrate` using current foundation outputs → create/review/apply the saved plan updating the
  Lambda/task definition → wait stable → trigger and verify one sync.
- First-time enablement: foundation/Aurora with `steampipe_enabled=false` → `make migrate` →
  repository-only post-migration ECR bootstrap if needed → build/push image → full saved-plan apply
  enabling `steampipe_enabled=true` → wait stable → trigger and verify one sync.
- If this ordering cannot be met, the new Lambda must not be deployed.

### RED evidence

After adding the focused structure assertion but before correcting the runbook:

```text
not ok - runbook must place make migrate before apply tfplan in the deployment-order section
```

### Files

- Operator/decision/reference: `docs/runbooks/steampipe-quota-and-staleness.md`,
  `docs/decisions/021-quota-isolated-inventory-reads.md`, and
  `docs/reference/03-data-aurora.md`.
- Approved sources: the Phase 1 design and Task 5 implementation plan.
- Static guard: `tests/structure/test-steampipe-fanout.sh`.
- Evidence: this Task 5 report.

### Verification

| Command/check | Result |
|---|---|
| Scoped `TBD`/`TODO`/`PLACEHOLDER` scan of ADR-021, Aurora reference, runbook, and approved design | Passed: no matches |
| Local Markdown link existence check for those documents | Passed |
| Precise runbook section-4 order check | Passed: first `make migrate` precedes first `apply tfplan` (relative lines 29 < 35) |
| `bash tests/structure/test-steampipe-fanout.sh` | Passed, including the new migration-before-Lambda documentation assertion |
| `git diff --check` | Passed |

### Concerns

- First-time enablement needs a repository-only saved target plan after migration because the
  Steampipe ECR repository is itself gated by `steampipe_enabled`. That bootstrap is explicitly
  limited to ECR; the sync Lambda/event rule remain absent until the final full saved-plan apply.
- Controller deployment and post-deploy sync verification remain operator actions; this round
  changed documentation and a static structure assertion only.
