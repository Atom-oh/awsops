<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 0bd6ce7f4bef · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# src/app/api — Server API routes (v1)

## What this is
Next.js App Router server endpoints. Every dynamic endpoint the browser calls is a `route.ts` file under this directory. The set spans an SSE AI router, AWS/CloudWatch metric readers (msk/rds/elasticache/opensearch/etc.), Steampipe query/inventory, AgentCore status, cost endpoints, external datasource CRUD/query, AI diagnosis reports, alert-webhook ingestion, and notification dispatch.

## Scope note (v1 vs v2)
This is the **v1 legacy app** (`src/`, CDK/EC2/Steampipe). v1 rules apply here and do NOT carry to v2 (`web/`, `terraform/v2/`). Most importantly: v1 serves under the `/awsops` basePath, so v1 fetch URLs use the `/awsops/api/*` prefix. v2 serves at root `/` with `/api/*` — do not flag v1's prefix as a bug, and do not import v1 conventions into v2 review.

## Conventions a reviewer must enforce
- **SSRF / allowlist on all outbound fetch.** Any `fetch` to an external host must route through the datasource allowlist + SSRF protections (`datasource-client.ts`). Reject new code that hits arbitrary user-supplied hosts directly.
- **No shell injection.** AWS CLI invocations use `execFileSync` with array args only — never string concatenation / shell-interpolated commands. CloudWatch metric routes especially.
- **Mask sensitive fields in responses.** Datasource tokens/passwords must be redacted before returning to the client.
- **Multi-account scoping.** When a request carries `accountId`, queries must go through `buildSearchPath()` for tenant isolation — don't let an account read another's data.
- **No blocking on long work.** Long-running tasks (report generation) use SSE or an async job pattern; never block a single request to completion (request-timeout risk).
- **Error shape.** Separate user-safe `error` from internal `detail`/stack: `{ error: string, detail?: string }`. Don't leak stack traces or internal paths to the client.

## Banned patterns / gotchas
- Direct unvalidated outbound `fetch` to a request-derived URL (SSRF).
- Building AWS CLI commands as concatenated strings or via a shell.
- Returning raw secrets/tokens or raw exception stacks in the JSON body.
- Skipping `buildSearchPath()` on a multi-account request.
- Admin-only routes (event-scaling, alert-settings actions) must gate on admin config — verify the check exists and is server-side.

## Where logic belongs
Endpoint handlers stay thin: validation + auth/account scoping + delegation. Shared concerns (datasource clients, SSRF guard, search-path building, masking) live in shared libs, not duplicated per route.
