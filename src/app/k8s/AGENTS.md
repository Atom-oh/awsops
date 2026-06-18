<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 6594829efc1d · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# EKS / Kubernetes Pages (`src/app/k8s`)

## What this module is
v1 (`src/`) Next.js App Router route segment for EKS/Kubernetes views: cluster Overview (`page.tsx`), plus `nodes/`, `pods/`, `deployments/`, `services/` list pages and a K9s-style terminal explorer (`explorer/`). Read-only operational views.

## Scope boundary (v1, not v2)
This lives under `src/` — the **v1** app (CDK/EC2/Steampipe, `/awsops` basePath). v1 conventions apply here and do NOT carry over to v2 (`web/`, `terraform/v2/`). Do not import v2 patterns; do not apply v2's root-path / node-pg rules here.

## Architectural boundaries
- These pages render data; **kubeconfig registration logic lives in the `/api/k8s` route**, not in these page files. Don't push EKS Access Entry / registration code into the view layer.
- View rendering reuses shared components from `src/components/k8s/` (`K9sResourceTable`, `K9sDetailPanel`, `K9sClusterHeader`, `NamespaceFilter`) — prefer these over bespoke tables/panels.
- Data comes from Steampipe (`kubernetes` plugin tables, `trivy` for CVE) via the API layer; OpenCost cost data belongs to the separate `eks-container-cost` page, not here.

## Conventions a reviewer must enforce
- Every page file starts with `'use client'`.
- All fetch URLs use the **`/awsops/api/*` prefix** (v1 basePath rule).
- Component imports are default exports (`import X from '...'`).
- StatsCard `color` uses a name (e.g. `'cyan'`), never a hex value.
- All K8s queries route through `buildSearchPath(accountId)` for per-account connections; multi-cluster disambiguation uses the Steampipe `kubernetes.context` column.
- Pages gate on `features.eksEnabled` / `features.k8sEnabled` — accounts without the flag hide these routes in the Sidebar.

## Gotchas / banned patterns (must flag in review)
- **SQL injection**: user-supplied values (`nodeName`, ENI IDs, etc.) must be whitelist-validated before they are interpolated into SQL. Never interpolate raw input.
- The `warningEvents` query requires the `involved_object_kind`, `involved_object_name`, and `count` columns — omitting them breaks the events view.
- Don't bypass `buildSearchPath` / hard-code a cluster context.
