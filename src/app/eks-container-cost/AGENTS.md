<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 02b487305c8c · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# EKS Container Cost

A v1 (`src/`) Next.js 14 App Router route segment: an EKS Pod cost-analysis page with a **dual data source** and graceful fallback.

## What it is
- `page.tsx` — the dashboard (StatsCards, charts, Pods/Nodes tabs, calculation-basis panel).
- Paired API route `src/app/api/eks-container-cost/route.ts` and queries `src/lib/queries/eks-container-cost.ts` (logic belongs there, not in the page).

## Data sources & fallback (the core behavior to verify)
- **OpenCost (primary)**: reads `opencostEndpoint` from `data/config.json`, hits OpenCost REST API. Exposes 5 cost items — CPU, Memory, Network, Storage (PV), GPU. Requires Prometheus + Metrics Server + OpenCost.
- **Request-based (fallback)**: Steampipe `kubernetes_pod` + `kubernetes_node`. Only 2 cost items — CPU, Memory — derived from resource requests. Formula: Pod request ratio × EC2 node hourly rate (50% CPU + 50% Memory).
- **Auto-detection**: if `opencostEndpoint` is set and reachable → `dataSource: 'opencost'`; otherwise → `dataSource: 'request-based'`. The UI must show Network/Storage/GPU columns **only** in OpenCost mode — never surface those columns under the request-based fallback.

## Conventions a reviewer must enforce (v1 `src/` rules)
- Page files start with `'use client'`.
- **All fetch URLs use the `/awsops/api/*` prefix** (v1 basePath). This is v1-only — do NOT apply the v1 prefix to v2 (`web/`, `terraform/v2/`), and conversely v2's root-path `/api/*` rule does not apply here.
- Component imports are `import X from '...'` (default export).
- StatsCard `color` takes color **names** (e.g. `'cyan'`), not hex.
- CloudWatch metric APIs invoke the AWS CLI via `execFileSync` — no shell string interpolation (shell-injection guard). Flag any `exec`/shell-concatenation introduced here.

## Related
- ECS counterpart: `src/app/container-cost/` (Fargate pricing) — keep the two cost pages conceptually distinct.
- OpenCost install is an out-of-band script, not part of this module.
