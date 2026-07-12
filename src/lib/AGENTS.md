<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 267c3b0c8ca2 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

## Scope note (v1)
This is the **v1 legacy** module (`src/`, CDK/EC2/Steampipe, `/awsops` basePath). v1 rules here do **NOT** apply to v2 (`web/` + `terraform/v2/`): in v2 there is no Steampipe pg Pool and no `/awsops` prefix. Don't cross-apply conventions when reviewing.

## What this module is
Core libraries for the AWS/Kubernetes ops dashboard: Steampipe DB connection + SQL query definitions, resource/cost inventory & snapshots, app config, AgentCore stats/memory, alert pipeline (types → correlation → diagnosis → knowledge → notify), external datasource clients, report generation (PPTX/DOCX/PDF), and event pre-scaling.

## Architectural boundaries (enforce in review)
- **All DB access goes through `steampipe.ts`** (`runQuery()` / `batchQuery()`). Reject any code that opens its own pg connection or shells out to Steampipe. Pool is shared and bounded (`max: 10`, `BATCH_SIZE: 8`, 120s statement timeout, 300s node-cache TTL).
- SQL query text lives in `queries/*.ts`; auto-collect agents live in `collectors/*.ts` (see `collectors/CLAUDE.md`). Don't inline ad-hoc SQL elsewhere.
- Config/state is JSON-file based (`data/...`, per-account dirs) — the v1 pattern. Per-user isolation for memory; per-account dirs for inventory/cost.
- `auth-utils.ts` only **decodes** the Cognito JWT payload — actual signature verification happens upstream at Lambda@Edge. Don't treat decode as auth.

## Gotchas / banned patterns a reviewer must catch
- **Never use the Steampipe CLI** — the pg Pool is ~660x faster.
- **No `$` in SQL** (Steampipe/FDW quirk).
- **No SCP-blocked columns in list queries** (org policy denies them → query failure).
- **Verify column names via `information_schema.columns`** before writing/changing a query.
- **JSONB nesting traps**: MSK `provisioned`, OpenSearch `encryption_at_rest_options`, ElastiCache `cache_nodes` — access nested fields, not top-level.
- **CloudWatch FDW exhausts the pg Pool** — monitoring queries are deliberately excluded from `cache-warmer.ts`; don't add them back. Multi-account warming caps at 3 account variants.
- **SSRF protection** in `datasource-client.ts` is load-bearing: IPv4/IPv6 private-CIDR block + zero redirects. Any change to outbound HTTP must preserve these.
- Steampipe runs with `--database-listen network` (VPC Lambda access on :9193) — connection assumptions depend on this.
