# ADR-001: v2 Foundation

## Status

Accepted **2026-06-22**. Consolidates legacy ADRs 001, 005, 024, 030, and 037.
Inventory rollout clarified **2026-08-31** by ADR-021. Repository evidence checked **2026-09-13**.

## Context

v1 coupled a latency-sensitive web server, memory-heavy Steampipe, and image builds on one EC2 host,
with application state in local JSON. v2 separates request serving, durable state, and background work.
The legacy Fargate proposal's CDK/service layout was not the implemented architecture.

## Decision

- The private foundation root is `terraform/v2/foundation/`. Use Terraform with a partial S3 backend
  and `use_lockfile`; shared-infrastructure changes use a reviewed saved plan, never auto-approve.
  CDK is historical foundation infrastructure; target-account onboarding templates are separate.
- Serve Next.js at `/` on arm64 Fargate. The web BFF handles authenticated requests and bounded reads;
  long, heavy, or OOM-prone work goes through ADR-009's asynchronous tier.
- Store application state in Aurora through shared `getPool()`. The frozen baseline schema plus
  ordered ULID migrations define the schema together; neither baseline table counts nor local JSON
  are current state authority. Do not edit merged migration checksums or append new tables to the baseline.
- Keep the edge private: CloudFront TLS to VPC Origin HTTPS:443, internal ALB HTTPS:443, then web
  HTTP:3000. ALB ingress uses the CloudFront VPC Origins service security group. No public ALB.
- AgentCore supplies domain MCP tools (ADR-004). Live BFF Steampipe queries are disabled; bounded
  Steampipe inventory ingestion remains supported (ADR-010/021). The checked-in catalog contains
  both limited Aurora reads and direct domain tools; Aurora-only coverage is not implemented yet.
- AgentCore identifiers and the admin allowlist come from SSM. `data/config.json` is historical.
- Retain the accepted private-development/public-distribution ECR separation. Gate large/risky
  features explicitly, default off; this does not make the always-on foundation cost-free.

## Implementation and consequences

`web/lib/db.ts` now authenticates as `awsops_web` using per-connection IAM tokens. Do not infer
master-password injection from historical rotation incidents (ADR-015). Data API agent tools use
`awsops_sql_reader` (ADR-004), a separate credential and privilege boundary.

The split removes build/runtime contention and local-state loss, at the cost of operating multiple
services and a paid database floor. Preserve container contracts: arm64 images, runtime
`HOSTNAME=0.0.0.0`, worker `CMD`, and `/api/health`. Treat attached ALB security-group descriptions
as immutable to avoid replacement; secrets injected by ECS require execution-role permissions.

## Six Pillars

Reliability and Operational Excellence: durable state and isolated workers. Security: private origin,
scoped credentials, and reviewed infrastructure changes. Performance, Cost Optimization, and
Sustainability: bounded asynchronous work, arm64, and explicit feature gates.

## Evidence

`terraform/v2/foundation/{backend,network,edge,workload,data,workers}.tf`, `web/lib/db.ts`,
`web/lib/aws-data.ts`, `scripts/v2/agentcore/catalog.py`, and ADR-009/021.
