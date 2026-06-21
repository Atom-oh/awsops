<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 690d65fb33f3 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# App module (`src/app`)

## What this is
The **v1 (legacy)** Next.js 14 App Router surface: page components and API routes for the AWSops AWS/Kubernetes operations dashboard. Each subdirectory under `src/app` is a route segment; `app/api/*` holds the BFF route handlers. v1 runs as a single EC2/CDK/Steampipe monolith served under a `/awsops` basePath.

## Scope boundary (review-critical)
- This is **v1 (`src/`)**. The parallel **v2** rewrite lives under `web/` + `terraform/v2/` and is served at the **root path** with Aurora/node-pg, AgentCore, async workers. **v2 rules do NOT apply here, and v1 rules do NOT apply to v2.**
- Pages are presentation + client fetch; AWS access and heavy logic belong in the `app/api/*` route handlers, not in page components.

## Conventions a reviewer must enforce
- **Every page file starts with `'use client'`.** Page components are client components.
- **Every fetch URL uses the `/awsops/api/*` prefix.** A bare `/api/*` fetch is a v1 bug (basePath mismatch). This is the single most common v1 regression.
- Component imports are **default exports**: `import X from '...'`.
- `StatsCard` `color` takes a **color name** (e.g. `'cyan'`), never a hex value.
- Admin-only pages/routes (accounts, alert-settings, event-scaling) gate on the configured admin-email list — verify the guard is present, not just hidden in the UI.

## Gotchas / banned patterns
- **CloudWatch-metric API routes must call AWS CLI via `execFileSync` (arg array), never a shell string** — prevents shell injection. Flag any `exec`/string-interpolated command building.
- Datasource routes must keep **SSRF protection** when fetching user-supplied external endpoints (Prometheus/Loki/Tempo/ClickHouse/etc.).
- Alert-webhook ingestion relies on **HMAC verification** — don't weaken or bypass it.
- `event-scaling` is **plan/script generation only — no execution**; adding any mutating/execute path is out of scope for this surface.
- Logout (`api/auth`) deletes an **HttpOnly cookie server-side**; keep the cookie HttpOnly.

## Where logic belongs
- Page (`*/page.tsx`): client UI, calls `/awsops/api/*`.
- Route handler (`app/api/*/route.ts`): AWS SDK/CLI access, token tracking, SSE streaming, security controls. Detailed route contract is in `src/app/api/CLAUDE.md`.
