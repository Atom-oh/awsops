<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: a81b786ac404 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# ECS Container Cost (v1 module)

This is a **v1** page (`src/`, legacy production app — CDK/EC2/Steampipe, `/awsops` basePath). v1 rules apply here; v2 conventions (`web/`, `terraform/v2/`, root path) do **not**.

## What it is
ECS Task cost-analysis page. Estimates per-task Fargate spend from task metadata + Container Insights metrics. EC2 launch-type tasks are shown as N/A (no node-cost allocation).

## Architectural boundaries
- `page.tsx` is the client page (dashboard: stats cards, charts, task table, calculation-basis panel).
- Data/query logic belongs in `src/lib/queries/container-cost.ts`; the BFF route is `src/app/api/container-cost/route.ts`. Keep cost math and AWS access out of the page component — the page consumes the API.
- Data sources: Steampipe `aws_ecs_task` (task metadata) and CloudWatch `AWS/ECS/ContainerInsights`. Fargate unit pricing is configurable via `data/config.json` `fargatePricing` (not hard-coded).
- Sibling, do not conflate: EKS container cost is a separate module (`src/app/eks-container-cost/`, OpenCost + request-based).

## Cost calculation (review for correctness)
- Fargate cost = (CPU units / 1024) × vCPU hourly rate + (Memory MB / 1024) × GB hourly rate.
- Default rates are region-specific (ap-northeast-2); pricing should flow from config, not literals.

## Conventions a reviewer must enforce (v1)
- Page files start with `'use client'`.
- All fetch URLs use the `/awsops/api/*` prefix (v1 basePath). A bare `/api/*` here is a bug.
- Component imports are default exports (`import X from '...'`).
- `StatsCard` `color` takes a name (e.g. `'cyan'`), never a hex value.
- CloudWatch metric APIs invoke the AWS CLI via `execFileSync` (argument array) — never shell-string interpolation. Flag any `exec`/template-string command construction as a shell-injection risk.
