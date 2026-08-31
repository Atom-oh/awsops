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
