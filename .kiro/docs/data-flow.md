# Data Flow

Read [AGENTS.md](../../AGENTS.md) for policy and
[web/CLAUDE.md](../../web/CLAUDE.md) for the web boundary.

- Dashboard requests use `/api/*`. BFF handlers use Aurora through
  `web/lib/db.ts`, scoped AWS SDK reads, or read-only Kubernetes APIs.
  Authentication, authorization, and ownership checks follow `web/lib/auth.ts`.
- Chat enters `web/app/api/chat/route.ts`. Routing comes from `web/lib/route.ts`
  and the resolver; AgentCore invokes the selected gateway's tools. Gateway
  wiring comes from `scripts/v2/agentcore/catalog.py` and
  `terraform/v2/foundation/ai.tf`. Multi-gateway synthesis requires both routing
  flags in the chat handler.
- Chat's Steampipe SQL and collector paths remain disabled by
  `steampipeAvailable()`. The separately gated batch inventory sync writes Aurora;
  its flag does not enable live Steampipe chat queries.
- Domain work is submitted through its dedicated authorized route, then
  `web/lib/jobs.ts` and SQS. The dispatcher starts Step Functions, which selects
  Lambda or Fargate execution. Workers record progress/results in Aurora; failure
  handling and reaping are defined in `terraform/v2/foundation/workers.tf` and
  `scripts/v2/workers/`.

Trace the changed request through these sources. Deployment status and gate
policy come from [BASELINE.md](../../docs/decisions/BASELINE.md), not this overview.
