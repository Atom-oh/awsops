<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 91d3c33f9bb8 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# External Datasources module

Scope note: this is a **v1 (`src/`) App Router** module — root path is `/awsops`, not the v2 (`web/`, `terraform/v2/`) root. v2 rules (no basePath, Aurora/node-pg) do NOT apply here.

## What it is
Pages to register, query, and AI-generate queries against 7 external observability platforms (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog). Two pages: `page.tsx` (datasource CRUD: register/delete/health-check/token-masking) and `explore/page.tsx` (query console — natural language → query, result tables/charts).

## Architectural boundaries (where logic belongs)
- UI pages stay thin; query/HTTP logic lives in `src/lib/`:
  - `datasource-client.ts` — outbound HTTP client (SSRF guard + allowlist).
  - `datasource-registry.ts` — per-type metadata: health endpoints, query languages.
  - `datasource-prompts.ts` — per-type NL→query prompts.
  - `api/datasources/route.ts` — CRUD + query execute + AI-generate.
- Adding a new platform: register its metadata in `datasource-registry.ts` **first**, before wiring UI.

## Gotchas / banned patterns a reviewer must enforce
- **SSRF defense is load-bearing — do not weaken.** URLs must be DNS-resolved and private CIDRs blocked (10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7). The only allowed bypass is an account with `allowPrivateDatasource` feature true. Redirect-following is forbidden (max 0) — a redirect is a known SSRF bypass vector.
- **Secrets handling**: tokens/passwords are encrypted at rest and must be masked in API responses. Never return raw credentials.
- **No buffering large result sets** — query results stream row-by-row; buffering risks memory blowup. Reject changes that collect all rows in memory.
- **AI query generation must require explicit user confirmation** before execution — generated queries are shown, not auto-run.
- Health checks run on a 5-minute background cycle; failures surface a `degraded` UI badge (don't make health checks blocking/inline).

## v1 module conventions (apply to edits here)
- Pages start with `'use client'`; default-export components (`import X from '...'`).
- fetch URLs use the `/awsops/api/*` prefix (v1 basePath).
