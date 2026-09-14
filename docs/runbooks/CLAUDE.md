# Operational runbooks

Write concise English procedures with symptoms, verification, action and relevant
code/ADRs. Commands name their working directory and use placeholders or configured
variables. Do not expose credentials, invent deployment evidence or treat a proposed
feature as enabled. Operator operations remain subject to the task's authorization
and saved-plan review; they are distinct from application autonomy under ADR-005.

| Runbook | Scope |
| --- | --- |
| [deploy-new-version.md](deploy-new-version.md) | Current v2 web/agent/worker/Lambda release boundaries and migration ordering |
| [private-ci-migrations.md](private-ci-migrations.md) | Private Fargate migration execution, source/digest receipts and recovery |
| [deployment-verifier.md](deployment-verifier.md) | Non-admin verifier credentials, residual session authority and migration TLS |
| [start-services.md](start-services.md) | Local development; production uses ECS |
| [add-new-page.md](add-new-page.md) | v2 page/data/auth/test conventions |
| [cognito-auth-issues.md](cognito-auth-issues.md) | Public-client login, edge verification and BFF sessions |
| [user-offboarding.md](user-offboarding.md) | Cognito access, revocation, ownership and scheduled work |
| [onboard-target-account.md](onboard-target-account.md) | Target role trust and explicit ExternalId policy |
| [multi-account-setup.md](multi-account-setup.md) | Redirect from the retired aggregator procedure |
| [istio-agent-eks-access.md](istio-agent-eks-access.md) | Tool-role EKS read access |
| [network-path-eks-access.md](network-path-eks-access.md) | Worker identity/topology read access |
| [k8sgpt-operator-install.md](k8sgpt-operator-install.md) | Operator-managed K8sGPT; no autonomous install |
| [alert-pipeline-troubleshoot.md](alert-pipeline-troubleshoot.md) | Authenticated ingress, job lifecycle, diagnosis and notification boundaries |
| [cache-warmer-issues.md](cache-warmer-issues.md) | Current cache/freshness triage; v1 warmer retired |
| [steampipe-quota-and-staleness.md](steampipe-quota-and-staleness.md) | Batch inventory limits, partial runs and freshness |
| [agent-sql-reader.md](agent-sql-reader.md) | SQL-reader grants/secret synchronization and enable order |
| [tempo-query-generation.md](tempo-query-generation.md) | Draft validation, discovery limits and schema refresh |
| [source-sync-observability.md](source-sync-observability.md) | Recorded backport contracts and deployment dependencies |
| [v1-decommission.md](v1-decommission.md) | Cognito operator credentials, dated teardown evidence, and remaining verification |
| [v1-to-v2-aurora-backfill.md](v1-to-v2-aurora-backfill.md) | Legacy history migration |
| [pr-review-specialists.md](pr-review-specialists.md) | Specialist PR-review panel contract: required roles, model pins, frame protocol and diagnostics |
| [pr-review-panel.md](pr-review-panel.md) | AI PR-review panel Kiro cells: quota, agent-fallback and preflight symptoms, causes and operator actions |

Current policy: `../decisions/BASELINE.md`. Use consolidated ADR numbers and qualify
legacy references. Preserve exact dated evidence in operational records; absence of
a recent check is unknown, not a newly confirmed deployment/teardown. Do not require
bilingual developer runbooks or use retired EC2 scripts as templates.
