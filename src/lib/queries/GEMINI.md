<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 8fc9bf2d9b7f · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# Queries Module (`src/lib/queries`)

## What this is
SQL query definitions for **Steampipe**. Each `*.ts` file exports the queries for one AWS/K8s service (EC2, VPC, S3, RDS, IAM, ECS/ECR, Lambda, K8s, cost, security, metrics, topology, etc.). This is pure query text + light shaping — no DB connection logic lives here.

## Scope boundary (v1 vs v2)
This is **v1** (`src/`, Steampipe-backed). v2 (`web/`, `terraform/v2/`) does **not** use Steampipe SQL for live queries — it uses Aurora + AgentCore MCP tools. Rules here apply to v1 only; do not import these into v2 web/BFF code.

## Architectural boundaries
- Files here only **define** queries. **All execution goes through `runQuery()` / `batchQuery()` in `../steampipe.ts`** — never open a pg connection or shell out from a query file.
- Query files should stay declarative: query string + minimal JSONB/column shaping. Orchestration, caching, multi-account fan-out belong in `steampipe.ts` / callers, not here.
- Some surfaces (e.g. Bedrock metrics) are CloudWatch-API-driven, not Steampipe — a query file may be reference-only.

## Conventions & gotchas a reviewer must enforce
- **Verify column names against `information_schema.columns` before adding/changing a query** — Steampipe schemas drift.
- **JSONB nesting is fragile** — extract carefully from MSK `provisioned`, OpenSearch `encryption_at_rest_options`, ElastiCache `cache_nodes`.
- **Known aliasing pitfalls**: S3 `versioning_enabled`; RDS must alias `class`; ECS `group` is a reserved word → quote as `"group"`.

## Banned patterns (reject in review)
- **No `$` characters in SQL** (breaks templating/parameterization).
- **Do not select SCP-blocked columns in list queries** — they fail the whole query under org SCPs.
- No direct DB access bypassing `steampipe.ts`; no Steampipe CLI invocation (the pg Pool path is the only sanctioned route and is far faster).
