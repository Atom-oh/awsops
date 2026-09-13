# Troubleshooting map

Start at the failing boundary and retain its actual error, account/region scope and
time window. Current v2 app state is Aurora; live chat reads use AgentCore MCP tools.
Steampipe supplies gated batch inventory and worker-side Powerpipe compliance;
live browser/chat SQL remains disabled. The old EC2/embedded-PG and `/awsops`
troubleshooting commands are retired.

| Failure | v2 guidance |
| --- | --- |
| Release/startup | [Root deployment commands](../../CLAUDE.md#commands-repository-root) (`make deploy`) and [setup](../onboarding.md) |
| Login/session | [Auth and identity](../reference/02-auth.md) |
| Inventory freshness/quota/denied hydration | [Inventory sync](../runbooks/steampipe-quota-and-staleness.md) |
| Agent SQL-reader authentication | [SQL reader](../runbooks/agent-sql-reader.md) |
| External query schema/generation | [Tempo](../runbooks/tempo-query-generation.md) |
| Alert/diagnosis progress | [Worker execution and recovery](../reference/06-workers.md) and [diagnosis evidence](../reference/observability-e2e.md) |
| Cross-account access | [Target onboarding](../runbooks/onboard-target-account.md) |
| EKS network-path identity | [Network path access](../runbooks/network-path-eks-access.md) |

Unknown or partial evidence is not an empty healthy result. Do not disable guards,
expand role trust, expose credentials or re-enable frozen actions to hide an error.
