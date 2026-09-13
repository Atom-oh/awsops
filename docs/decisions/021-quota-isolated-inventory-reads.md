# ADR-021: Quota-Isolated Inventory Reads

## Status

Accepted **2026-08-31**: target architecture approved and Phase 1 repository implementation recorded.
That implementation change did **not** run Terraform apply; controller deployment required separate
verification. Amended **2026-09-02** for hydrate-fallback observability and **2026-09-03** for manual
all-types dispatch. Repository evidence checked **2026-09-13**; no new deployment observation here.
ADR-005 remains frozen; this decision authorizes read-only collection and querying only.

## Context

Read-only calls still consume production quotas. Concurrent chat/domain tools can compete with
operators and deployments, so inventory/configuration reads need bounded collection and explicit
freshness instead of unlimited request-time API fan-out.

## Decision

The accepted **target**, after staged cutover, is quota-limited Steampipe collection into Aurora,
then domain AgentCore MCP reads from that inventory. After Phase 3, bounded CloudWatch Metrics/Logs
are the intended remaining live AWS-query exceptions, with admission/time/result budgets.
This end-state is **not current enforcement against existing direct domain targets**.

| Phase | Repository state checked 2026-09-13 | Remaining boundary |
|---|---|---|
| 1 | Shared Steampipe limiter, Lambda backpressure, durable last-success, partial/freshness disclosure, bounded scheduled/manual refresh implemented | Deployment must be verified separately |
| 2 | Limited ops `inventory-read-target` coexists with direct domain inventory/configuration targets | Expand domain coverage, prove parity, then retire direct targets |
| 3 | Accepted CloudTrail/cost/FinOps cache-and-retirement target remains pending | Do not claim CloudWatch-only live access is already implemented |

The Phase 2 reader contract rejects silent live-API fallback when inventory is stale/unavailable;
return evidence with freshness and last-success timestamps. Existing direct domain tools are not a
new policy violation merely because the future cutover has been accepted.

### Batch versus live Steampipe

`steampipe_enabled` defaults false and gates the warm Fargate Steampipe service plus sync Lambda.
Manual and scheduled inventory refresh use that asynchronous Lambda path, including its supported
SDK collector additions. `web/lib/aws-data.ts:steampipeAvailable()` remains unconditionally false:
request-time BFF Steampipe SQL/collector execution is disabled. Do not remove or enable one path to
"fix" the other's intentional behavior.

### Quota and freshness controls

Declared Phase 1 defaults, verified in `variables.tf`/`steampipe.tf`:

| Setting | Default | Allowed range / meaning |
|---|---:|---|
| `steampipe_aws_max_concurrency` | 4 | Integer 1–20 |
| `steampipe_aws_bucket_size` | 4 | Integer 1–40 |
| `steampipe_aws_fill_rate` | 2 | 0.1–20 requests/second |
| `steampipe_sync_reserved_concurrency` | 4 | Integer 1–20 |
| `inventory_stale_after_minutes` | 30 | Integer 1–1440 minutes |
| Scheduled sync | 15 minutes | EventBridge schedule |
| Async event age | 900 seconds | Expire old work |
| Async retries | 0 | Avoid delayed retry bursts |

`spc_render.py` emits one unscoped shared `awsops_global` limiter for Steampipe connections/accounts/
regions. Lambda concurrency backpressures query sessions; it is not an AWS API admission budget.
SDK collectors and direct domain MCP calls do not automatically inherit the Steampipe limiter.

`inventory_sync_runs` tracks the current run and separately retains `last_success_at` and
`last_success_row_count`. Full success includes reachable expected accounts and genuine zero rows.
Unreachable expected accounts produce partial, preserve their last-good rows, and do not advance
last-success. Freshness also considers the oldest current row, not only the latest attempt.

`unknown_attribute_count` discloses steady denied attributes and, since **2026-09-02**, successful
hydrate-free fallbacks including transient hydrate failures. A succeeded run with unknown attributes
is degraded; those unknowns alone do not block last-success advancement/pruning. Other transiently
incomplete SDK records are skipped to preserve good content. A failed base query fails the type and
skips pruning (ADR-010). Never equate zero rows with unavailable evidence or succeeded with complete evidence.

Manual admin Sync-all sends the same `{type:"all"}` payload as the schedule, with the same reserved
concurrency, per-type advisory locks, event age, and retries. It has no server-side cooldown; this
recorded limitation is not permission to claim the call is free or unlimited.

### Migration-gated rollout

Terraform packages the sync Lambda, whose running UPSERT requires `inventory_sync_runs.run_token`.
For an existing enabled environment: push the new Steampipe image without rolling, run `make migrate`
against current foundation outputs, then create/review/apply the saved plan updating Lambda/task definition.

For first enablement: establish foundation/Aurora with Steampipe off, migrate, build/push the image,
then enable Steampipe in the final saved-plan apply. If needed, an ECR-only bootstrap can precede the
image push after migration, but must not create the sync Lambda/event rule prematurely.
`make deploy` rolls web and does not replace this Lambda ordering. These are rollout prerequisites,
not a new instruction to apply infrastructure during documentation work.

### Operational observability

Keep structured limiter configuration and sync dispatch/complete/busy/failed events. Success,
unknown attributes, partial/unreachable accounts, and hydrate fallback must be distinguishable.
Use safe error categories and counts without raw errors, credentials, or account IDs.
`inventory_sync_hydrate_fallback` identifies the loss of hydrated attributes and a cause-specific
operator remedy; a permission denial is different from limiter/time-budget exhaustion.

## Consequences

Bounded collection protects availability and exposes stale/incomplete evidence. Existing direct tools
retain quota exposure until the accepted retirement phases are implemented. Batch defaults do not
prove deployed settings or a cost-free stack. Database migrations precede code that requires them.

## Six Pillars

Reliability and Performance Efficiency: bounded collection and durable read evidence. Operational
Excellence: observable freshness and staged cutover. Security: no new mutation authority.
Cost Optimization: explicit feature gates and collection limits.

## Evidence

`scripts/v2/steampipe/{spc_render,sync_lambda}.py`, `terraform/v2/foundation/{variables,steampipe}.tf`,
`agent/lambda/inventory_read_mcp.py`, `scripts/v2/agentcore/catalog.py`, `web/lib/aws-data.ts`,
[Quota/staleness operating procedure](../runbooks/steampipe-quota-and-staleness.md), and
`docs/superpowers/specs/2026-08-31-steampipe-quota-safe-aurora-mcp-design.md` (accepted target provenance).
