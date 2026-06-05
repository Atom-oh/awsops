# AWSops v2 — Inventory Data Layer: Steampipe → Aurora (D1 keystone) Design Spec

> Branch `feat/v2-architecture-design`. Brainstormed 2026-06-05. Re-prioritized after user feedback "where did the v1 dashboard go?" — v2 dropped Steampipe and never ported v1's ~35-page Steampipe-backed inventory dashboard. This is the **keystone data layer** that unblocks porting those pages. (Supersedes the originally-planned P3-D "EKS kubeconfig"; in-cluster EKS view becomes a later page-wave.)

## Goal
Bring v1-parity inventory data to v2: a **warm Steampipe Fargate service** (stateless live AWS fetcher) feeds **Aurora `inventory_snapshots`** (durable store); the dashboard reads **Aurora only** (fast, survives Steampipe restarts), and a **Refresh button** triggers an immediate warm-Steampipe→Aurora sync. D1 delivers the data layer + ONE proof page (EC2). The other ~34 v1 pages port in later waves on this plumbing.

## Why this shape (resolved in brainstorming)
- **Steampipe is stateless** — a query-time FDW that calls AWS APIs and caches in-memory ~5min; it stores nothing durably, so a container restart loses nothing (AWS is the source of truth). The user's durability concern is addressed by making **Aurora the durable store**, not Steampipe.
- **Refresh must be instant** (v1 had it). A batch-job-per-refresh (Fargate cold start) is ~1–3 min — too slow. A **warm (always-on) Steampipe service** answers a re-query in seconds, so refresh = warm-Steampipe→Aurora sync.
- **Dashboard reads Aurora only** → fast, decoupled from Steampipe uptime, enables history; Steampipe just keeps Aurora fresh (on schedule + on refresh).

## Architecture
```
                         ┌─ scheduled sync (EventBridge → sync path)   [DEFERRED to a follow-up]
warm Steampipe Fargate ◀─┤
 (:9193 FDW, stateless,  └─ Refresh button → BFF sync-now (warm → seconds)
  ReadOnlyAccess role)
        │ query results UPSERT
        ▼
   Aurora inventory_snapshots ◀── dashboard pages read Aurora only (lib/db.ts) — durable, fast, restart-safe
```

## Scope (D1)
**In:** (1) Steampipe Fargate **service** (custom image: steampipe + aws plugin; warm; private subnet; dedicated SG; Cloud Map discovery; ReadOnlyAccess IAM; password via Secrets Manager). (2) Aurora **inventory schema** (generic latest-snapshot table). (3) `web/lib/steampipe.ts` (pg pool → the Steampipe service). (4) **Sync** `syncInventory(type)` = query Steampipe → UPSERT Aurora. (5) **EC2 proof page + routes**: `GET /api/inventory/ec2` (read Aurora) + `POST /api/inventory/ec2/refresh` (warm-sync → Aurora → return), an `/ec2` page reading Aurora with a **Refresh** button. (6) Everything gated by **`var.steampipe_enabled`** (count → $0 when off).

**Out (later waves D2+):** the other ~34 v1 pages (s3/rds/iam/vpc/ebs/lambda/ecs/ecr/dynamodb/elasticache/msk/opensearch/cloudwatch/cloudtrail/cloudfront/waf/security/compliance/cost-detail/topology/inventory/monitoring/…) — each = port v1's query + a page on this plumbing; **scheduled (cron) sync** via EventBridge (D1 ships the refresh path; the timer is a small follow-up); **multi-account aggregator** (D1 = host single-account); CIS/compliance benchmark; in-cluster EKS (original P3-D).

## Components
| File / resource | Responsibility |
|---|---|
| `scripts/v2/steampipe/Dockerfile` | `FROM` Steampipe base + `steampipe plugin install aws` + config; entrypoint `steampipe service start --database-listen network --database-port 9193 --foreground`. arm64. |
| `scripts/v2/steampipe/aws.spc` | Steampipe AWS connection config (default cred chain = the task role; `regions = ["*"]` or the deploy region). |
| `terraform/v2/foundation/steampipe.tf` | ECR repo, ECS service+taskdef (warm, cpu 512/mem 2048), dedicated SG (ingress 9193 from web `service` SG), Cloud Map private namespace + service (DNS `steampipe.<ns>`), task role w/ `ReadOnlyAccess` managed policy, `random_password` → Secrets Manager → `STEAMPIPE_DATABASE_PASSWORD`. All `count = var.steampipe_enabled ? 1 : 0`. |
| `terraform/v2/foundation/data/schema.sql` (append) | `inventory_snapshots` columns (verify/extend existing): one row per `(resource_type, account_id)` holding latest `data JSONB` + `captured_at`; UPSERT key. |
| `web/lib/steampipe.ts` | pg `Pool` → Steampipe service (host=Cloud Map DNS env `STEAMPIPE_HOST`, port 9193, user `steampipe`, password from secret env, db `steampipe`, ssl `rejectUnauthorized:false` — Steampipe network listener is self-signed TLS). `query(sql)` helper. Mirrors v1 `src/lib/steampipe.ts` (pool, statement_timeout). |
| `web/lib/inventory.ts` | `readSnapshot(type)` (Aurora SELECT latest) + `syncInventory(type)` (run the type's Steampipe SQL → UPSERT Aurora `inventory_snapshots` → return rows). Holds the per-type SQL (D1: `ec2`; waves add more). |
| `web/app/api/inventory/[type]/route.ts` | `GET` verifyUser → `readSnapshot(type)` (Aurora). |
| `web/app/api/inventory/[type]/refresh/route.ts` | `POST` verifyUser → `syncInventory(type)` (warm Steampipe→Aurora) → fresh rows + `captured_at`. |
| `web/app/ec2/page.tsx` | EC2 table from `/api/inventory/ec2`; **Refresh** button → `POST …/refresh` → re-render + show `captured_at`. (DataTable from P3-B.) |
| `web/components/ui/RefreshButton.tsx` | Reusable: triggers refresh, shows spinner + "last updated". |

## Data flow
- **Page load** → `GET /api/inventory/ec2` → `readSnapshot('ec2')` → Aurora latest snapshot (fast). Shows rows + `captured_at` ("N분 전").
- **Refresh** → `POST /api/inventory/ec2/refresh` → `syncInventory('ec2')`: pg-query the warm Steampipe (`SELECT … FROM aws_ec2_instance`) → `INSERT … ON CONFLICT (resource_type, account_id) DO UPDATE SET data=…, captured_at=now()` → return fresh rows. Page re-renders. Warm Steampipe → seconds.
- Steampipe restart → Aurora keeps last snapshot (dashboard unaffected); next sync re-fetches from AWS.

## Steampipe SQL (D1: ec2) — in `web/lib/inventory.ts`
```sql
-- ec2 (v1 columns): account_id + instance fields. (waves port the other types' v1 SQL)
SELECT instance_id, instance_type, instance_state, region, account_id,
       private_ip_address, public_ip_address, vpc_id, launch_time
FROM aws_ec2_instance ORDER BY launch_time DESC
```
(Per CLAUDE.md Steampipe rules: verify columns via `information_schema.columns`; `account_id` column required for multi-account-readiness.)

## Error handling
- **Steampipe unreachable / disabled** → `refresh` returns 503 `{status:'error',message:'inventory service unavailable'}`; the page still shows the last Aurora snapshot (graceful — durable store decouples it). `GET` (Aurora) keeps working.
- **Empty snapshot** (never synced) → page shows "데이터 없음 — Refresh를 눌러 수집" + the Refresh button.
- **Auth** → all routes `verifyUser` (401).
- **Steampipe query error** (FDW hang, throttle) → 500 with message; v1's FDW-hang/watchdog lessons noted (the warm service should `--database-listen network`; pool `statement_timeout` ~120s).

## IAM / security
- Steampipe task role: `arn:aws:iam::aws:policy/ReadOnlyAccess` (broad read for 380-table coverage; tighten to `ViewOnlyAccess`+`SecurityAudit` later if desired — noted). No write perms.
- Steampipe service: private subnet only, dedicated SG ingress 9193 **from the web `service` SG only** (no public exposure). Egress → NAT for AWS APIs.
- DB password: `random_password` → Secrets Manager; both the Steampipe task (env `STEAMPIPE_DATABASE_PASSWORD` valueFrom) and the web task (read for the pool) reference it. Web task role gets `secretsmanager:GetSecretValue` on that secret.
- Cost note: a warm Steampipe Fargate task (0.5vCPU/2GB) ≈ ~$20/mo always-on. Gated by `steampipe_enabled` (off=$0). Acceptable for the dashboard; documented.

## Testing
- **Unit (vitest):** `lib/inventory.ts` `syncInventory` (mock Steampipe pg `query` + Aurora pool → UPSERT shape) + `readSnapshot` (mock pool → rows); routes (mock auth+lib → 401, 200 GET, refresh 200/503). `lib/steampipe.ts` pool config.
- **Build:** `npm run build` (new routes + `/ec2` page).
- **TF:** `terraform plan` with `steampipe_enabled=false` → "No changes" (gating proof); with `=true` → the Steampipe service + SG + Cloud Map + IAM + secret created, nothing else disturbed.
- **E2E (post-deploy, controller):** enable steampipe → apply → build+push the steampipe image + web → `/ec2` page: empty → click Refresh → warm Steampipe queries EC2 → Aurora UPSERT → table shows real instances + "방금 업데이트"; reload → fast Aurora read; (optional) restart the Steampipe task → page still shows the snapshot (durability proof).

## Non-goals (explicit)
Scheduled cron sync (EventBridge timer — small follow-up after the refresh path proves out); the other ~34 pages (waves); multi-account aggregator; CIS/compliance; in-cluster EKS (original P3-D); tightening ReadOnlyAccess.
