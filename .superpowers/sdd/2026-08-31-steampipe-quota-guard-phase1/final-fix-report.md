# Final Whole-Branch Fix Report

Date: 2026-09-01
Branch: `feat/steampipe-quota-guard`
Scope: seven Important findings from the final Phase 1 review

## Status

All seven findings were implemented in one final fix wave with test-first RED/GREEN evidence.
The takeover audit found and closed one remaining response-level SDK partial-failure path inside
finding 4 before final verification. No Terraform apply, AWS mutation, image push, service rollout,
or ADR-005 capability change was performed.

## RED/GREEN evidence

### 1. Freshness authority

RED:

```bash
PYTHONPATH=agent/lambda python3 -m pytest agent/lambda/test_inventory_read_mcp.py -q
```

Result: `1 failed, 32 passed`. The failure showed that the SQL still used
`COALESCE(oldest_captured_at, last_success_at)` and allowed current rows to establish freshness
without durable success.

GREEN:

```bash
PYTHONPATH=agent/lambda python3 -m pytest agent/lambda/test_inventory_read_mcp.py -q
```

Result: `33 passed`.

The effective timestamp now requires `last_success_at` and uses:

```sql
CASE WHEN last_success_at IS NULL THEN NULL
     ELSE LEAST(last_success_at, COALESCE(oldest_captured_at, last_success_at))
END
```

Tests cover first-run partial/failed data as `unavailable`, old repeated partial data as `stale`,
recent repeated partial data as `degraded`, stale-before-degraded precedence, and retained bound
Data API parameters.

### 2. Admin-only manual inventory refresh

RED:

```bash
cd web
npx vitest run 'app/api/inventory/[type]/refresh/route.test.ts' \
  app/api/security/refresh/route.test.ts
```

Result: `4 failed, 6 passed`. Authenticated non-admin callers still reached enqueue logic and
neither route called `isAdmin`.

GREEN:

```bash
cd web
npx vitest run 'app/api/inventory/[type]/refresh/route.test.ts' \
  app/api/security/refresh/route.test.ts
```

Result: `10 passed`.

Both routes now return 401 for unauthenticated callers, 403 for authenticated non-admin callers
without invoking the sync Lambda, and queue only for admins. The existing inventory-type/IAM gate
still runs after the route-wide admin gate as defense in depth.

### 3. Truthful fan-out enqueue

RED:

```bash
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py -q
```

Result: `3 failed, 31 passed`. The first invoke exception aborted the loop, non-202 responses were
treated as success, and the return/log record lacked queued/failed outcomes.

```bash
cd web
npx vitest run app/api/security/refresh/route.test.ts
```

Result: `3 failed, 3 passed`. One-failure and all-failure cases both returned the old unconditional
202 response.

GREEN:

- Sync Lambda focused suite: `34 passed` at the fan-out GREEN checkpoint.
- Security refresh route: `6 passed`.

`type=all` now continues across each self-invoke failure, validates async status 202, emits one
redacted `inventory_sync_dispatch` record, and returns:

- `dispatched` when every type queued,
- `partial` when at least one queued and at least one failed,
- `failed` when none queued.

The security refresh route uses settled per-type outcomes, returns 202 when at least one type
queued, returns 503 when none queued, and discloses only safe type names and counts.

### 4. SDK collector partial failures

RED:

```bash
PYTHONPATH=scripts/v2/steampipe python3 -m pytest \
  scripts/v2/steampipe/test_sync_sdk_partial.py \
  scripts/v2/steampipe/test_sync_s3_public.py \
  scripts/v2/steampipe/test_sync_lambda_queries.py -q
```

Result: `8 failed, 34 passed`. Collectors returned only three fields, printed raw `ClientError`
messages/resource identifiers, and `sync()` treated incomplete SDK rows as full success.

An additional S3 expected-absence RED check produced `1 failed, 4 passed`: `NoSuchBucketPolicy`
was initially counted as a partial failure.

The takeover audit added one more RED case:

```bash
PYTHONPATH=scripts/v2/steampipe python3 -m pytest \
  scripts/v2/steampipe/test_sync_sdk_partial.py -q
```

Result: `1 failed, 3 passed`. OpenSearch Serverless `BatchGetCollection` returned a successful
`collectionDetails` subset plus `collectionErrorDetails`, but the collector ignored those
response-level failures and would have allowed unsafe stale pruning.

GREEN:

- OpenSearch Serverless response-error regression: `4 passed`.
- SDK collector/sync focused suite: `44 passed`.
- S3 expected-absence suite: `5 passed`.
- Final sync lifecycle focused suite after the full-success prune assertion: `35 passed`.

CloudFront VPC-origin, ALB listener, S3 public-access, S3 security, and OpenSearch Serverless
helpers now return successful rows plus safe `failure_count`/`failure_types` metadata. OpenSearch
Serverless converts only the documented response `errorCode`; collection IDs, names, and messages
are never logged or returned. Known absence codes remain normal states. Any real swallowed SDK
sub-call failure:

- finalizes the resource type as `partial`,
- upserts successful rows,
- skips both inventory stale-prune phases,
- skips same-day snapshot replacement,
- preserves durable `last_success_at`/`last_success_row_count`,
- logs only safe counts/codes, never exception messages, resource IDs, bucket names, or account IDs.

An empty-failure SDK result retains normal phase-1 prune, row-level prune, snapshot, and durable
last-success behavior.

### 5. EventBridge delivery ceiling

RED:

```bash
bash tests/structure/test-steampipe-fanout.sh
```

Result included:

```text
not ok - EventBridge target must set retry_policy age 900 and retries 0
```

GREEN: the structure test passes with `aws_cloudwatch_event_target.inv_sync.retry_policy` set to
900-second maximum age and zero retries. The existing Lambda async invoke configuration remains in
place.

### 6. `inventory_summary` count contract

RED:

```bash
PYTHONPATH=agent/lambda python3 -m pytest \
  agent/lambda/test_inventory_read_mcp.py \
  agent/lambda/test_inventory_view_contract.py -q
```

Result: `2 failed, 41 passed`. The query had no explicit host-scoped `current_count`, and the
AgentCore catalog did not describe the field.

GREEN: `43 passed`.

The summary query now aggregates `inventory_resources` in a separate host/`self`-scoped CTE before
joining the singleton run ledger, preventing count multiplication. It returns explicit
`current_count` while retaining `row_count`, durable success fields, freshness, and all
backward-compatible fields. The AgentCore catalog describes the scope and both count meanings.

### 7. Controller approval comments

RED:

```bash
bash tests/structure/test-steampipe-fanout.sh
```

Result included:

```text
not ok - both first-time applies must be immediately preceded by # Controller-approved operation only:
```

GREEN: both first-time-enablement apply commands now have the exact required comment immediately
above them. The structure test extracts the first-time section, requires exactly two documented
applies, and verifies every one has the qualifier.

## Final verification

| Check | Result |
|---|---|
| `PYTHONPATH=scripts/v2/steampipe python3 -m pytest scripts/v2/steampipe -q` | `82 passed`, 36 existing Python 3.9/Boto3 warnings |
| Inventory reader/view tests | `43 passed` |
| `cd agent && python3 -m pytest test_agent.py -q` | `55 passed` |
| `cd web && npx vitest run` | 244 files passed, 1 skipped; 2,391 tests passed, 1 skipped |
| `cd web && npm run build` | Production build, lint/type check, and static generation passed |
| `bash tests/structure/test-steampipe-fanout.sh` | Passed |
| `node scripts/v2/migrate.mjs --status` | Passed; 53 valid migration files recognized |
| `DRY_RUN=1 OFFLINE=1 node scripts/v2/migrate.mjs` field scan | Passed; freshness migration emitted `run_token`, `last_success_at`, and `last_success_row_count` |
| Scoped Terraform `fmt -check` | Passed for `steampipe.tf`, `ai.tf`, and `variables.tf` |
| `terraform -chdir=terraform/v2/foundation validate` | Passed normally with one existing Cloud Map `failure_threshold` deprecation warning |
| AgentCore catalog check | Passed |
| Python compilation | Passed |
| Docs placeholder check | Passed on ADR-021, Aurora reference, runbook, and approved design |
| Local Markdown link existence | Passed |
| `git diff --check` | Passed |

## Preserved invariants

- Read-only product posture; no mutation/autonomy/BYO-MCP enablement.
- Run-token compare-and-set finalization and migration-first rollout order.
- Raw exception/error redaction in lifecycle and dispatch logs.
- `BaseException` re-raise behavior with best-effort cleanup and no misleading terminal log.
- ARM64 Lambda/container configuration.
- `steampipe_enabled=false` default-off/zero-resource gating.
- Lambda async event-age/retry controls retained in addition to the EventBridge target ceiling.
- Shared-infrastructure applies remain saved-plan, controller-only operations.

## Concerns

- Terraform validation reports the pre-existing Cloud Map
  `health_check_custom_config.failure_threshold` deprecation warning.
- The local Python 3.9 environment emits the existing Boto3 end-of-support warning; deployed
  Lambda runtimes remain Python 3.11/3.12.
- The web suite emits existing Vite CJS and expected fixture stderr/chart-size warnings; one live
  routing test remains intentionally skipped.
- Shell startup emits unrelated `otelcol.service`/`sudo` noise.
- The feature branch is one commit behind `origin/main` (`#258`, unrelated inventory UI work);
  this fix wave did not rebase, merge, push, or create a PR.
