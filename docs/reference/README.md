# Implementation References

These references describe implemented component contracts and operational limits.
[BASELINE.md](../decisions/BASELINE.md) defines policy and feature gates; source,
migrations, and tests establish behavior. A reference or default flag value does
not prove deployment. Use dated runbooks for environment-specific evidence.

This checkout uses `terraform/v2/foundation/`. Public samples have a
separate root; verify the checkout before copying commands. Developer references
are English-only; application localization and multilingual `docs-site` guides
remain separate.

| Component | Reference | Primary sources |
| --- | --- | --- |
| Private edge | [Edge and network](01-edge-network.md) | `edge.tf`, `network.tf`, `workload.tf` |
| Login and authorization | [Auth and identity](02-auth.md) | `auth.tf`, edge template, `web/lib/auth.ts` |
| Persistent state | [Aurora](03-data-aurora.md) | `data.tf`, migrations, application DB clients |
| Request handling | [Web BFF](04-web-bff.md) | `web/`, `workload.tf`, deploy script |
| AI tools and routing | [AgentCore](05-agentcore.md) | provisioner catalog, `agent/`, chat handler |
| Async execution | [Workers](06-workers.md) | `workers.tf`, `scripts/v2/workers/` |
| Cluster access | [EKS](07-eks.md) | `eks.tf`, registry, Kubernetes proxy |
| Evidence and coverage | [Observability](observability-e2e.md) | trace graph, diagnosis, job timing |

Terraform filenames above are relative to `terraform/v2/foundation/`.
Each reference links to the relevant implementation; inspect registries instead
of maintaining page, table, gateway, or tool counts here.

For shared policy and commands, read root [CLAUDE.md](../../CLAUDE.md).
For deployment procedures use [runbooks](../runbooks/). Historical plans and
review records explain earlier work; they do not authorize frozen capabilities
or override current code contracts.
