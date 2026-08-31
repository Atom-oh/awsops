# Quota-Safe Steampipe Inventory and Aurora-Backed AgentCore MCP Design

Date: 2026-08-31  
Status: Proposed  
Scope: AWSops v2 inventory collection and AWS-native AgentCore MCP read paths

## 1. Problem

AWSops v2 currently has two AWS read paths:

1. A flag-gated Steampipe Fargate service periodically materializes inventory into Aurora.
2. Most AgentCore domain MCP Lambdas call AWS control-plane APIs directly with boto3.

The second path can consume the same account-, Region-, service-, and operation-scoped API
quotas used by production deployment, scaling, and operations systems. Read-only IAM prevents
mutation but does not prevent an availability impact caused by throttling.

The current implementation has useful per-tool result caps, but no shared downstream request
budget, no Agent Lambda reserved concurrency, and no uniform application-level retry policy.
Repeated chat requests or multi-route fan-out can therefore create direct AWS API bursts outside
the Steampipe collector.

## 2. Clarification of the v2 Improvement

v2 did not move Steampipe's embedded PostgreSQL engine into Aurora. Steampipe still runs its
embedded database inside an ARM64 Fargate task. The durable improvement was that collected
inventory is written into managed Aurora tables and served from there, rather than retained on an
EC2-attached EBS volume or local JSON files.

This design preserves that improvement:

- Steampipe remains a stateless, replaceable collection engine.
- Aurora remains the durable inventory and AgentCore read source.
- End-user request traffic does not cause inventory control-plane API calls.

## 3. Agreed Product Decisions

- Inventory freshness remains a 15-minute scheduled sync.
- Administrators retain an explicit manual refresh path.
- AgentCore inventory/configuration tools use Aurora, not live AWS control-plane APIs.
- Live AWS API exceptions are limited to bounded CloudWatch metrics and CloudWatch Logs queries.
- CloudTrail, Cost Explorer, Compute Optimizer, Cost Optimization Hub, Budgets, and Trusted
  Advisor data move to scheduled Aurora caches before their live AgentCore targets are retired.
- Missing or stale inventory must be disclosed. It must not silently fall back to live AWS APIs.
- All paths remain read-only and do not change the ADR-005 frozen mutation/autonomy boundary.

## 4. Alternatives Considered

### A. Keep direct MCP API calls and add Lambda retry/concurrency controls

This reduces bursts but leaves many independent Lambdas competing for downstream quotas. Reserved
concurrency protects Lambda capacity, not the aggregate count of service API calls made inside each
invocation. It also leaves pagination, caching, and retry behavior duplicated across handlers.

Rejected as the primary architecture. It is retained only as defense in depth for the small live
telemetry exception.

### B. Route every AWS read, including telemetry, through Steampipe

This provides one collector boundary but makes interactive metrics and log diagnosis depend on a
15-minute inventory cycle. It also treats event/telemetry queries as inventory and would require
persisting potentially high-volume logs and metrics in Aurora.

Rejected because it weakens interactive diagnosis and creates an inappropriate storage pipeline.

### C. Quota-limited Steampipe inventory, Aurora-backed MCP, bounded live telemetry

Steampipe performs scheduled inventory collection behind explicit concurrency/rate controls.
Aurora is the source for inventory and configuration tools. Only bounded CloudWatch metric/log
operations remain live, behind a separate admission budget and strict range/result limits.

Selected.

## 5. Target Architecture

```text
EventBridge rate(15m) / admin refresh
              |
              v
bounded sync dispatcher (reserved concurrency)
              |
              v
Steampipe Fargate
  - explicit plugin limiter
  - account/Region connection scope
  - read-only task role
              |
              v
sync Lambda -> Aurora inventory_resources / inventory_sync_runs
              |
              +-------------------------------+
              |                               |
              v                               v
Web inventory APIs                  AgentCore domain gateways
                                            |
                                            v
                                  Aurora inventory MCP targets

Live exception:
AgentCore monitoring gateway
  -> bounded CloudWatch Metrics / Logs tools only
```

## 6. Delivery Decomposition

The change is split into three independently deployable phases. A later phase must not be enabled
until its data contract and freshness behavior are verified.

### Phase 1 — Steampipe quota guard and sync backpressure

1. Render an explicit AWS plugin limiter in every generated `aws.spc`.
2. Keep the current 15-minute EventBridge schedule.
3. Cap concurrent inventory sync Lambda executions so the `type=all` asynchronous fan-out cannot
   create an unbounded set of simultaneous Steampipe queries.
4. Make limiter and sync-concurrency values explicit Terraform variables with conservative
   defaults and validation. Disabling `steampipe_enabled` still creates zero resources.
5. Add structured sync logs for resource type, elapsed time, row count, throttling/degraded state,
   and freshness.
6. Preserve manual refresh, but make it use the same bounded queue/concurrency path as scheduled
   refresh. It must not bypass the limiter.

The Steampipe plugin limiter is the authoritative control for upstream AWS requests made by
inventory collection. Lambda reserved concurrency is backpressure for query sessions and protects
the Fargate service from a large asynchronous invocation fan-out.

### Phase 2 — Aurora-backed inventory MCP targets

1. Extend `inventory_read_mcp.py` into a domain-aware Aurora reader while retaining the
   least-privilege `awsops_sql_reader` Data API boundary.
2. Register Aurora-backed targets on the network, container, data, and security gateways. The same
   Lambda implementation may back multiple gateway targets, but each target exposes only its
   domain's schemas.
3. Preserve user-facing tool intent where practical:
   - list and describe resource inventory,
   - topology and static relationship lookup,
   - inventory freshness,
   - unused-resource analysis.
4. Remove live AgentCore target exposure for inventory/configuration operations after equivalent
   Aurora contracts exist. The old Lambda source may remain dark until final cleanup, but the
   provisioner catalog must not register those tools.
5. Remove the corresponding live AWS permissions from the Agent Lambda role once no registered
   target needs them.
6. Expand Steampipe sync coverage for required contract gaps before retiring a live tool. Known
   examples include ENIs, Elastic IPs, listeners, EKS cluster configuration, and any detail fields
   absent from the current `inventory_resources.data` projection.
7. Add explicit-column `sql_reader` views through a ULID migration. Raw provider payloads and
   sensitive JSON fields remain inaccessible to the Agent role.

No Aurora-backed tool may silently call a live AWS API when data is absent. It returns a structured
`unavailable` or `stale` result containing the latest successful sync timestamp.

### Phase 3 — Scheduled operational and cost caches

Before retiring the remaining non-telemetry live targets:

1. Collect CloudTrail summaries/events into bounded Aurora tables on a schedule appropriate to the
   product view.
2. Collect Cost Explorer, Budgets, Compute Optimizer, Cost Optimization Hub, and Trusted Advisor
   results through scheduled workers with per-source failure isolation.
3. Expose those tables through explicit-column `sql_reader` views and Aurora-backed MCP tools.
4. Retire the live `cloudtrail-mcp`, `cost-mcp`, and `finops-mcp` targets only after parity and
   freshness tests pass.

These collectors use the existing worker spine, not synchronous BFF work.

## 7. Live Telemetry Exception

Only the following AWS-native live capabilities remain registered:

- CloudWatch `GetMetricData`/metric discovery needed to answer bounded interactive metric queries.
- CloudWatch Logs Insights start/status/result/cancel and bounded log-group discovery.

Controls:

- per-account and per-Region admission budget,
- strict time-range, result-count, and query-count clamps,
- in-flight request deduplication and short TTL cache,
- bounded retry with exponential backoff and full jitter for throttling/service-unavailable errors,
- no retry for validation, authorization, or not-found errors,
- circuit-breaker/degraded response when the downstream budget is exhausted,
- no multi-route fan-out amplification of the same telemetry query.

The initial live telemetry budget is at most two concurrent calls and a token bucket of two requests
with a one-request/second refill for each account/Region/service key. These defaults are
configuration, not a claim about AWS service quotas; operators may lower them immediately, while an
increase requires load evidence showing that production headroom is preserved.

The AgentCore invocation quota is not treated as the downstream AWS API quota control. One Agent
invocation can issue multiple tool/API calls, so enforcement belongs at the telemetry tool boundary.

## 8. Freshness and Failure Semantics

- Healthy: latest successful inventory sync is at most 30 minutes old.
- Stale: latest successful sync is older than 30 minutes; return data with a stale warning.
- Unavailable: no successful sync exists for the requested type; return no fabricated inventory and
  do not fall back to a live control-plane call.
- Partial: a scheduled collection completed with one or more source/type failures; successful types
  remain queryable and failed types disclose their own error/freshness state.
- Manual refresh returns queued/running/completed status and observes the same concurrency budget.
- Repeated throttling opens a short circuit for the affected account/Region/service key and delays
  further collection rather than creating a retry storm.

## 9. Configuration

Phase 1 adds explicit, validated settings:

- Steampipe global maximum concurrent upstream calls: default `4`, allowed `1..20`.
- Steampipe global token bucket: default capacity `4`, refill `2` requests/second; capacity allowed
  `1..40`, refill allowed `0.1..20`. Scope is intentionally omitted so the budget is shared across
  all connections, Regions, services, and actions instead of multiplying per production account.
- Inventory sync Lambda reserved concurrency: default `4`, allowed `1..20`.
- Inventory stale threshold, default 30 minutes.

Configuration is non-secret and may be provided as Terraform variables/runtime environment values.
Defaults must be conservative. Exact production values are confirmed by load testing and observed
sync duration; they are not inferred from a generic AWS-wide quota because quotas differ by service,
operation, account, and Region.

## 10. Observability

Required metrics/logs:

- sync invocations, success, partial, failure, and duration by resource type,
- latest successful sync age by resource type/account,
- Steampipe limiter wait/saturation,
- downstream throttling count by service/operation/account/Region where available,
- sync Lambda concurrent executions and throttles,
- queued async invocation age/failures,
- live telemetry cache hit, single-flight join, budget rejection, and circuit-open counts.

Alerts:

- any inventory type stale for more than 30 minutes,
- sync Lambda throttles or async delivery failures,
- repeated upstream throttling,
- Steampipe service unhealthy,
- Aurora-backed Agent tool unavailable because required sync data is missing.

## 11. Security and Product Posture

- No AWS mutation permission or tool is added.
- Steampipe and scheduled collectors use curated read-only IAM.
- AgentCore Aurora readers use the dedicated `awsops_sql_reader` secret and explicit-column views.
- Cross-account scope remains the registered `AWSopsReadOnlyRole`; no arbitrary role ARN.
- No master database secret is exposed to Agent Lambdas or the Steampipe task.
- Gateway target permissions remain scoped to exact Lambda ARNs with confused-deputy protection.
- Existing frozen remediation/autonomy flags remain off.

This decision changes read routing and quota isolation, not the product's read-only posture.

## 12. Testing Strategy

### Phase 1

- renderer tests assert the plugin limiter is present exactly once and values are validated,
- multi-account/Region rendering preserves connection and aggregator behavior,
- Terraform tests/static checks assert reserved concurrency and default-off resource gating,
- sync tests verify scheduled and manual refresh use the same bounded path,
- failure tests verify throttling produces degraded state without a retry storm.

### Phase 2

- contract tests map every retired live inventory tool to an Aurora-backed equivalent,
- catalog tests assert inventory/configuration tools point to Aurora targets on each gateway,
- tests fail if a retired target remains registered,
- Data API tests assert bound parameters, result caps, freshness metadata, and no boto3 service
  client creation,
- SQL reader migration tests assert explicit columns/JSON projections and no `public` grants,
- fixture parity tests compare representative old live-tool outputs with new Aurora outputs.

### Phase 3

- worker tests cover idempotency, per-source failure isolation, scheduling, and stale data,
- cache reader contract tests cover freshness and partial collection,
- catalog tests assert CloudTrail/cost/FinOps live targets are removed only after cache targets exist.

### Verification

- Steampipe and inventory reader Python suites,
- Agent suite,
- web Vitest suite and Next build for affected UI/contracts,
- Terraform fmt/validate and saved plan review,
- AgentCore provisioner dry/idempotency checks,
- post-deploy smoke: inventory freshness, domain gateway tool discovery, Aurora-only list/describe,
  bounded live CloudWatch query, and no direct control-plane calls from retired tools.

## 13. Rollout and Rollback

Phase 1 schema/code rollout is migration-gated because Terraform packages the updated `inv-sync`
Lambda and its running UPSERT requires the migration-owned `inventory_sync_runs.run_token` column.

- Existing `steampipe_enabled=true` environment: build/push the new Steampipe image without rolling
  the service; run `make migrate` using the current foundation outputs; then create/review/apply the
  saved Terraform plan that updates the Lambda/task definition; wait for service stability; trigger
  and verify one sync.
- First-time enablement: create foundation/Aurora with `steampipe_enabled=false`; run
  `make migrate`; create/push the Steampipe image; then create/review/apply the saved plan enabling
  `steampipe_enabled=true`. If the gated ECR repository does not yet exist, create only that
  repository with a post-migration repository-only bootstrap plan; do not create the sync
  Lambda/event rule before migration.
- `make deploy` rolls the web ECS service, not the Terraform-owned sync Lambda. If this order cannot
  be satisfied, do not deploy the new Lambda.

After that schema-safe Phase 1 rollout:

1. Keep existing MCP routing unchanged and observe at least one full sync cycle.
2. Deploy new sync fields/views and Aurora tools while old live tools remain registered.
3. Compare outputs and freshness in shadow/parity tests.
4. Update the AgentCore catalog to retire direct inventory/configuration tools.
5. Prune unused IAM permissions after target retirement is verified.
6. Repeat the shadow-then-retire sequence for Phase 3 caches.

Rollback restores the previous catalog target set. Aurora data and Steampipe collection remain
compatible, so rollback does not require destructive schema or resource changes.

## 14. Decision Records and Documentation

Implementation requires:

- new ADR-021 recording quota-isolated inventory reads and bounded telemetry exceptions,
- `docs/decisions/BASELINE.md` update in the same change,
- amendments to ADR-001 and ADR-010 where they currently state that live AWS queries are generally
  handled by AgentCore MCP Lambdas,
- `docs/reference/03-data-aurora.md` and `docs/reference/05-agentcore.md` updates,
- an operator runbook for limiter tuning, stale inventory, and rollback.

## 15. Acceptance Criteria

- Scheduled inventory collection cannot exceed the configured Steampipe and sync concurrency
  budgets.
- A user chat asking to list or describe a synced resource performs no direct AWS control-plane API
  call.
- The response discloses sync freshness and never silently falls back to live inventory.
- Only bounded CloudWatch metrics/log operations remain live after Phase 3 completion.
- CloudTrail/cost/FinOps live targets are retired only after scheduled cache parity.
- No mutation/autonomy capability is enabled.
- All relevant tests, Terraform validation, and AgentCore target contract checks pass.
