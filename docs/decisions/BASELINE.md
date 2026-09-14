# AWSops Decision Baseline

Current decision authority for v2. Read this before the numbered ADRs; implementation detail belongs
in `docs/reference/`, operating procedures in `docs/runbooks/`, and historical evidence in its dated record.
Code/defaults were checked on **2026-09-13** against the worktree based on **4234dadf**. This audit
made no AWS deployment query or change. Declared defaults below are not claims about live settings.

## §0 North Star

Help operators run AWS workloads safely through evidence-based diagnosis and remediation proposals,
covering Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization,
and Sustainability. Each new feature/decision identifies at least one pillar it improves.

The accepted product is an operations dashboard plus AI diagnosis. Safe execution/automation remains
an aspiration, not permission to enable AWS-resource mutation. Changing this goal requires owner approval;
changing the freeze requires the separate process in §1.

Architecture: Terraform, private edge, Fargate thin BFF, Aurora state, asynchronous workers, AgentCore
section agents, and governed data integrations. Large/risky features have explicit rollout gates.

## §1 Invariants and review rules

- **Read-only means no AWS-resource mutation or autonomous mitigation by the product** (ADR-005).
  Internal application records and governed external DATA operations are distinct (ADR-007).
  ADR-019 defines the constrained Athena query case inside this invariant.
- **FROZEN** means do not enable. Reversal requires a new ADR, multi-AI panel review, and a dated
  owner override. Disabled remediation code/tables are retained intentionally; their presence is
  not activation. Arbitrary BYO-MCP and mutating tools stay frozen.
- **One narrow mutation exception:** ADR-015, owner Junseok Oh, **2026-07-01**, after PR #114's
  **2026-06-29** panel. Only `ecs:UpdateService(forceNewDeployment=True)` for the host's own web
  service on its own Aurora master-secret rotation, unchanged task definition/image, one-service
  IAM scope, secret matching, default-off. IAM permits UpdateService on that ARN; the Lambda
  enforces restart-only arguments and secret matching. No broader authority follows from it.
- **GATED** means eligible for controlled enablement after its documented dependencies and controls
  are satisfied. It does not mean live, nor does it waive a frozen dependency.
- Custom policy/catalog read failure denies custom candidates, never grants Phase-1 access.
  Built-in routing and product help remain usable under ADR-003/004; custom pins are not silently substituted.
- Verify defaults in `terraform/v2/foundation/variables.tf`, `ai.tf`, `secret-rotation.tf`, and
  runtime/provisioner sources. Disabled feature resources can be absent while shared infrastructure
  still costs money; a false flag does not guarantee a whole-stack no-change plan.
- New ADRs or gate changes require a same-change update to this index/register. Accepted policy,
  repository implementation, and deployed state are separate facts.
- Scope is v2. v1 code removal is recorded **2026-07-12**; later AWS cleanup has separately dated
  evidence in ADR-016. Neither old v1 mechanisms nor historical review conclusions enforce current v2 behavior.
- Legacy numbers require qualification and [ADR-MAPPING.md](ADR-MAPPING.md). Historical plans,
  including `docs/superpowers/reference/`, are not current implementation references.

## §2 Gate register

Terraform booleans below default **false**, except the explicit migration switch. Runtime env gates
also default false. Consult the linked ADR and source for complete dependencies.

| Classification | Gate / capability | Boundary and dependencies | Decision |
|---|---|---|---|
| FROZEN | `remediation_enabled` | No AWS mutation/autonomous mitigation; retain disabled substrate | ADR-005 |
| FROZEN | `CLICKHOUSE_OFFICIAL_MCP` (runtime env) | No stdio activation without equivalent query/SSRF defenses plus new ADR, panel, dated override | ADR-017 |
| GATED, narrow owner exception | `secret_rotation_redeploy_enabled` | Own-secret rotation restart of own web service only; requires CloudTrail event delivery. Current BFF uses IAM DB auth | ADR-015 |
| GATED analysis | `incident_lifecycle_enabled` | Requires workers; triage/investigation/RCA/prevention recommendations only | ADR-006 |
| GATED, blocked dependency | `rca_writeback_enabled` | Requires lifecycle and independent write-back role. Current validation still requires frozen remediation; do not satisfy it by enabling remediation | ADR-006 |
| GATED analysis | `k8sgpt_enabled` | Read Result CRDs; no cluster fixes. New operator installation/enablement awaits the ADR-006 §5 compatibility review | ADR-006 |
| GATED infrastructure | `agentcore_enabled`, `workers_enabled` | AgentCore and async execution infrastructure; no mutation permission implied | ADR-004, ADR-009 |
| GATED reads | `integrations_enabled`, connector `*_vpc_enabled` | Curated connectors, scoped secrets and path-specific egress controls | ADR-007 |
| GATED reads | `datasource_diagnosis_enabled` | Governed external evidence collection; requires agentcore, integrations, and workers | ADR-007, ADR-008 |
| GATED communication | `diagnosis_notify_enabled` | Single-topic SNS notifications; runtime pause and test-send behavior in ADR-013 | ADR-013 |
| GATED governed write | `integrations_write_enabled` | Requires agentcore/integrations/workers, independent IAM/kill-switch, DLP and human gate | ADR-007 |
| GATED reads | `official_mcp_enabled` | Requires agentcore/integrations, catalog host pin, exact endpoint acknowledgement, runtime fail-closed tool allowlist | ADR-017 |
| GATED routing | `hybrid_routing_enabled`, `multi_route_synthesis_enabled` | Classifier and synthesis have separate gates/IAM; golden routing checks before enablement | ADR-003 |
| GATED experiment | `ANTHROPIC_AGENT_LOOP_ENABLED` (runtime env) | Bedrock chat loop; BFF must not forward client-controlled `agentLoop` | ADR-003, ADR-008 |
| GATED query generation | `graph_querygen_enabled` | Requires datasource diagnosis and agentcore; Code Interpreter precheck is best effort (unavailable skips, explicit failure rejects); ClickHouse graph fallback only | ADR-018 |
| GATED query generation | `diag_signal_querygen_enabled` | Requires datasource diagnosis; Explore chips only, separate budget and read gate | ADR-018 |
| GATED batch | `steampipe_enabled` | Warm FDW and inventory sync; Powerpipe CIS also uses the FDW. Live BFF Steampipe stays disabled; FinOps checks persisted freshness | ADR-010, ADR-021 |
| GATED cost | `ai_cost_tracking_enabled` | Requires workers; invocation-log aggregation into `ai_usage_daily` | ADR-012 |
| GATED batch | `diagnosis_schedule_enabled`, `ai_insights_enabled` | Worker-backed scheduled diagnosis / insight generation | ADR-008, ADR-009 |
| GATED read observation | `eks_auto_register_enabled` | Requires workers; records operator-created View/AdminView access in Aurora, with no EKS mutation permission | BASELINE §2 only; no dedicated ADR |
| GATED batch | `finops_baseline_enabled` | Requires workers; EBS rule also needs successful inventory sync or reports partial | ADR-020 |
| GATED analysis | `network_path_check_enabled` | Requires workers and one adapter-safety review before enablement; new runs blocked by `LIVE_TOPOLOGY_IMPLEMENTED=false`. Worker cross-account reads follow ADR-011; live pod/node identity needs an EKS Access Entry. Source-side SG/NACL/routes plus destination SG/NACL adapters when its own ENI is known; destination return routing remains unassessed. Calico/Route53/Ingress implemented, Cilium/Istio adapters remain stubs. No Create/DeleteNetworkInsightsPath grant or active probe | BASELINE §2 only; no governing ADR |
| GATED analysis | `sg_rule_activity_enabled` | Requires workers; `sg_rule_scan` plus isolated Athena broker, SELECT-only/prefix restrictions | ADR-019 |
| Migration switch, default **true** | `legacy_email_owner_match` | Temporary verified-email matching for reads and report PATCH/DELETE. Complete reviewed ownership backfill and confirm zero residual legacy rows before disabling | ADR-002, ADR-009 |
| Ungated user request | Explore `POST /api/datasources/generate` | Authenticated draft generation; never executes/dry-runs/caches generated queries | ADR-018 |
| Deferred option | Neptune / alternate graph store | Postgres-first; legacy ADR-043 is provenance, not adoption | ADR-MAPPING |

### Dated deployment evidence

The previous register's live-state column was headed **2026-08-11**, with later rows
and amendments also present. Its recorded labels were:

- ON: `legacy_email_owner_match`, `diagnosis_notify_enabled`, `eks_auto_register_enabled`.
- OFF: `remediation_enabled`, `incident_lifecycle_enabled`, `rca_writeback_enabled`, `k8sgpt_enabled`, `integrations_write_enabled`, `datasource_diagnosis_enabled`, `graph_querygen_enabled`, `diag_signal_querygen_enabled`, `ANTHROPIC_AGENT_LOOP_ENABLED`, `secret_rotation_redeploy_enabled`, `official_mcp_enabled`, `CLICKHOUSE_OFFICIAL_MCP`, `finops_baseline_enabled`, `network_path_check_enabled`, `sg_rule_activity_enabled`.

The ungated Explore-generation row was labeled ON as a capability, and deferred
Neptune was N/A; neither is a feature-gate deployment observation.

These are historical labels, not checks performed on 2026-09-13. A later-added row
cannot inherit the earlier heading's verification date. The previous register had no
separate `integrations_enabled` live-state row; do not infer its deployed value here.
Current per-gate deployment state requires a fresh check.

Cognito `admin_only` recovery illustrates the distinction: merged **2026-08-04**, recorded applied
**2026-08-11** (ADR-002). Ownership migration completion has no new evidence here. See ADR-016 for
separately dated v1 cleanup and ADR-021 for implementation-versus-rollout limits.

## §3 Decision index

| ADR | Accepted decision | Main pillars |
|---|---|---|
| [001](001-v2-foundation.md) | Terraform foundation, private edge, thin BFF, Aurora, worker tier | Reliability, Operations |
| [002](002-auth-and-login.md) | Cognito edge authentication, BFF authorization/revocation, admin-only recovery | Security |
| [003](003-ai-agent-routing.md) | Per-turn hybrid routing and separately gated synthesis | Operations, Cost |
| [004](004-agentcore-gateways-runtime.md) | Section gateways, runtime customization, memory/interpreter, restricted SQL reader | Security, Operations |
| [005](005-aws-mutation-autonomy-frozen.md) | AWS mutation/autonomous mitigation frozen | Security, Operations |
| [006](006-incident-analysis-only.md) | Incident analysis only; blocked write-back dependency | Reliability, Operations |
| [007](007-external-data-integration-governance.md) | Governed external data reads/writes; curated connectors | Security, Operations |
| [008](008-ai-diagnosis-pipeline.md) | Evidence collection, direct Bedrock report rendering, formats and cost controls | Operations, Cost |
| [009](009-async-worker-backbone.md) | Durable async execution and ownership-scoped submission | Reliability, Security |
| [010](010-inventory-resource-model.md) | Batch inventory model, failure/freshness disclosure, hydrate fallback | Reliability |
| [011](011-multi-account.md) | Read-only STS federation and explicit trust requirements | Security |
| [012](012-cost-finops.md) | Cost Explorer availability, FinOps tools, AI usage attribution | Cost |
| [013](013-alerting-notification.md) | Machine ingress, single-topic notifications, authenticated downloads | Operations, Security |
| [014](014-cross-cutting-cache-i18n-cdn.md) | Application caching, UI/report language, dynamic CDN caching disabled | Performance |
| [015](015-operational-self-healing.md) | Dated own-secret rotation restart exception; no general self-healing permission | Reliability, Security |
| [016](016-v1-decommission.md) | Owner-directed v1 retirement and bounded historical evidence | Cost, Operations |
| [017](017-curated-official-mcp-presets.md) | Gated hosted presets; frozen ClickHouse stdio | Security, Operations |
| [018](018-llm-query-generation.md) | Separate contracts for worker fallbacks and user-requested drafts | Security, Cost |
| [019](019-athena-flow-log-query-classification.md) | Isolated SELECT-only Athena queries inside the read-only invariant | Security, Cost |
| [020](020-finops-baseline-recommendations.md) | Deterministic savings findings; optional LLM explanation | Cost |
| [021](021-quota-isolated-inventory-reads.md) | Bounded batch inventory; phased Aurora cutover | Reliability, Performance |
