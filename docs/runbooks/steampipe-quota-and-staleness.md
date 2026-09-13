# Runbook: Steampipe Quota and Inventory Staleness

Operate the bounded inventory batch, not live BFF Steampipe queries. Phase 1 implementation was
recorded **2026-08-31**, with observability amendments **2026-09-02** and Sync-all **2026-09-03**.
Repository/defaults checked **2026-09-13**; this audit did not apply or verify live deployment.
Limited Aurora MCP reads still coexist with direct domain targets (ADR-021).

[Inventory freshness data flow](../diagrams/inventory-freshness-dataflow.html).

## 1. Variables and defaults

| Terraform variable | Default | Allowed |
|---|---:|---|
| `steampipe_enabled` | false | Feature gate; does not make the shared foundation cost-free |
| `steampipe_aws_max_concurrency` | 4 | Integer 1–20 |
| `steampipe_aws_bucket_size` | 4 | Integer 1–40 |
| `steampipe_aws_fill_rate` | 2 requests/s | 0.1–20 |
| `steampipe_sync_reserved_concurrency` | 4 | Integer 1–20 |
| `inventory_stale_after_minutes` | 30 | Integer 1–1440 minutes |

Schedule: 15 minutes. EventBridge delivery and asynchronous Lambda invocation use 900-second event
age and zero retries. The shared unscoped `awsops_global` limiter bounds Steampipe upstream calls;
Lambda reserved concurrency limits sessions. Explicit SDK collectors and direct MCP tools do not
inherit the Steampipe limiter automatically. Admin manual refresh uses the same async Lambda path.

## 2. Review before deployment

The sync Lambda's running UPSERT needs `inventory_sync_runs.run_token`. Migrate **before** the saved
plan that deploys the new Lambda. `make deploy` rolls web and does not deploy this Lambda. Never use
`-auto-approve`; the controller applies reviewed saved plans. A false feature flag is not evidence
that the whole plan has no changes.

## 3. Inspect limiter configuration

The runtime renders `/home/steampipe/.steampipe/config/aws.spc` from Aurora account/region scope.
Validate the renderer locally; inspect effective values through logs, without enabling ECS Exec:

```bash
python3 -m pytest scripts/v2/steampipe/test_spc_render.py -q
```

```text
fields @timestamp, event, max_concurrency, bucket_size, fill_rate
| filter event = "steampipe_limiter_config"
| sort @timestamp desc
| limit 20
```

Expect one AWS plugin and one unscoped global limiter; compare its effective values with the reviewed
configuration. Do not multiply the intended budget by adding account/region scopes.

## 4. Deployment order

### Existing environment

Build/push the approved arm64 image without rolling; migrate; then plan/apply Lambda and task-definition
changes. Set the image tag in reviewed Terraform configuration to match the image being pushed.
Run from the repository root with initialized backend, correct credentials, and the intended region.

```bash
set -euo pipefail
: "${AWS_REGION:?Set the intended foundation region}"
: "${STEAMPIPE_IMAGE:?Set the approved full ECR image URI and tag}"
docker buildx build --platform linux/arm64 -f scripts/v2/steampipe/Dockerfile \
  -t "$STEAMPIPE_IMAGE" --push scripts/v2/steampipe
make migrate
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation plan -out tfplan
# Controller-approved operation only:
terraform -chdir=terraform/v2/foundation apply tfplan
```

Then wait for the configured service and trigger one bounded sync. `STEAMPIPE_SERVICE` is the actual
project-prefixed service name; do not infer it from a different deployment.

```bash
set -euo pipefail
: "${AWS_REGION:?Set the intended foundation region}"
: "${STEAMPIPE_SERVICE:?Set the deployed Steampipe service name}"
INV_CLUSTER=$(terraform -chdir=terraform/v2/foundation output -raw ecs_cluster_name)
INV_FUNCTION=$(terraform -chdir=terraform/v2/foundation output -raw inv_sync_function) || {
  echo 'Cannot read sync function output; verify Terraform access and feature deployment.' >&2
  exit 1
}
: "${INV_CLUSTER:?No ECS cluster output}"
: "${INV_FUNCTION:?No sync function output; check feature deployment}"
aws ecs wait services-stable --region "$AWS_REGION" \
  --cluster "$INV_CLUSTER" --services "$STEAMPIPE_SERVICE"
aws lambda invoke --region "$AWS_REGION" --cli-binary-format raw-in-base64-out \
  --function-name "$INV_FUNCTION" --invocation-type Event --payload '{"type":"ec2"}' \
  /tmp/awsops-inv-sync-response.json
```

An accepted Event invocation is not completed sync. Check the ledger/logs below.

### First-time enablement

Establish foundation/Aurora with Steampipe off. Complete migrations before either activation path:

```bash
set -euo pipefail
make migrate
```

If ECR does not exist, create **only** that repository through a reviewed saved target plan.
Verify that the plan contains no Lambda/event rule/service creation:

```bash
set -euo pipefail
terraform -chdir=terraform/v2/foundation plan \
  -target=aws_ecr_repository.steampipe -var='steampipe_enabled=true' -out tfplan-steampipe-ecr
# Controller-approved operation only:
terraform -chdir=terraform/v2/foundation apply tfplan-steampipe-ecr
```

Build/push the image, then persist `steampipe_enabled=true` and the matching
`steampipe_image_tag` in reviewed Terraform configuration. The ECR bootstrap's `-var` override
affects only that plan; it does not update the configuration used by later plans.
Then make and review a fresh full saved plan that enables the service and sync Lambda:

```bash
set -euo pipefail
terraform -chdir=terraform/v2/foundation plan -out tfplan
# Controller-approved operation only:
terraform -chdir=terraform/v2/foundation apply tfplan
```

Wait for service stability and verify one sync. Sync-all sends `{type:"all"}` through the same
limits/locks; it has no server-side cooldown.
Do not bypass the bounded path with parallel manual invocations.

## 5. Check logs and freshness

```text
fields @timestamp, event, max_concurrency, bucket_size, fill_rate,
       resource_type, row_count, unreachable_account_count,
  unknown_attribute_count, elapsed_ms, degraded, throttled,
  freshness, age_minutes, error_category, error_type
| filter event like /^inventory_sync_/ or event = "steampipe_limiter_config"
| sort @timestamp desc
| limit 100
```

| Signal | Meaning / response |
|---|---|
| `inventory_sync_dispatch` | Queued/failed type counts, not completion |
| `inventory_sync_busy` | Type advisory lock is held; do not create retry bursts |
| `inventory_sync_complete` | Inspect status and unknown attributes; succeeded alone does not mean complete visibility |
| `inventory_sync_hydrate_fallback` | Hydrated query failed and retried without its column; verify final completion separately |
| `inventory_sync_failed` | Safe error category/type; `superseded` means a newer run replaced the ledger row, which the old finalizer leaves untouched |

The ledger retains `last_success_at`/`last_success_row_count` across later running/partial/failed
attempts, including successful zero rows. A per-run token protects finalization from overwriting a
newer run. Freshness uses the older of durable success and oldest retained capture:

- `unavailable`: no durable success, even if a first partial run wrote rows.
- `stale`: effective age exceeds the configured threshold.
- `degraded`: recent evidence with a running/partial/failed attempt, or success with unknown attributes.
- `healthy`: recent success without unknown attributes.

Steady denied attributes and successful hydrate-free fallbacks disclose unknowns without blocking
last-success/pruning. Other transiently incomplete SDK records are skipped to retain good content.
Unreachable expected accounts preserve last-good rows and do not advance success. A failed base
query fails the type and skips pruning. Hydrate fallback itself does not override later partial/DB failures.

Run these queries through an already verified Aurora connection:

```sql
SELECT resource_type, status, finished_at, row_count,
       last_success_at, last_success_row_count, unknown_attribute_count
FROM inventory_sync_runs WHERE account_id = 'self' ORDER BY resource_type;

SELECT resource_type, account_id, region, min(captured_at) AS oldest_captured_at
FROM inventory_resources GROUP BY resource_type, account_id, region
ORDER BY oldest_captured_at;
```

The agent's safe views exclude raw errors/internal run tokens. `current_count` is current inventory
count; `row_count` is latest run count. Do not hide stale/unavailable evidence by live-API fallback.

The completion event intentionally omits account identifiers. Failure events expose safe
categories/types, not raw exception text or `run_token`; absence of those fields is deliberate.

## 6. Safe tuning

Use observed production headroom before raising limits. For hydration timeouts, review
`steampipe_aws_fill_rate`, the tunable named by the emitted remedy; the fixed statement-timeout
constant is not the documented operator knob. IAM/SCP denial needs permission review and
cannot be fixed by rate changes. Follow approved
operator changes, one control at a time, observing at least one full cycle and preserving prior values.
Lower limits through a reviewed saved plan when throttling or production contention appears.
These are safeguards, not universal service quotas.

## 7. Rollback

Restore prior limiter/concurrency/image settings through a reviewed saved plan; disabling the feature
is an operator option. Preserve Aurora inventory, sync ledger, and migration history. Phase 1 did not
retire direct AgentCore targets, so it has no catalog cutover to reverse. Verify last-success/freshness
and disclose stale data after stopping collection.

## Related

[ADR-010](../decisions/010-inventory-resource-model.md),
[ADR-021](../decisions/021-quota-isolated-inventory-reads.md),
`scripts/v2/steampipe/{spc_render,sync_lambda}.py`, `terraform/v2/foundation/steampipe.tf`.

## Optional host scope

The runtime guard is default off. Enabling `INVENTORY_HOST_ONLY=true` requires
`EXPECTED_HOST_ACCOUNT_ID`, exactly one enabled host registry row, and matching STS
identity. Prepare account-management enforcement first. This code change alone
enables no task or infrastructure flag; a task-definition rollout follows existing
DNS/approval controls. Regions remain the existing host scan scope, not Seoul-only.

Transient STS reads have three total attempts. Wrong identity or exhausted retries
prevents startup or records fatal shutdown with exit 1. Stop and restart share a lock;
crash backoff is interruptible. Ordinary SIGTERM remains graceful. Use
`python3 -m pytest scripts/v2/steampipe/test_host_scope.py -q` from the repository root
for the offline scope, retry, process-exit and concurrency regressions.
