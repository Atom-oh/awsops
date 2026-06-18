<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 27e16d8b0c7e · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# Alert Settings module

## What this is
The settings page for the alert pipeline: webhook ingestion → correlation → AI diagnosis → Slack notification. `page.tsx` is the admin-only UI (webhook URL/secret display, per-source mapping, Slack channel routing, HMAC secret rotation).

## Architectural boundaries (where logic lives)
The page is presentation-only; pipeline logic belongs in `src/lib/`, not in the page:
- `alert-types.ts` — event types + per-source normalizers (one per supported source).
- `alert-correlation.ts` — time/service/resource grouping, dedup, severity escalation.
- `alert-diagnosis.ts` — Bedrock diagnosis orchestrator (parallel collector/datasource fetch, change detection).
- `alert-knowledge.ts` — diagnosis history store, similarity search, stats.
- `slack-notification.ts` — Block Kit messages, severity channel routing, thread updates.
- API surface: `api/alert-webhook/route.ts` (ingest), `api/notification/route.ts` (dispatch).

A reviewer should reject pipeline/parsing/notification logic added directly to `page.tsx`.

## Supported sources
CloudWatch SNS, Alertmanager (Prometheus v4 webhook), Grafana (Unified Alerting), Generic JSON (requires mapping rules). Each source must route through its normalizer in `alert-types.ts` — no ad-hoc parsing.

## Rules a reviewer must enforce
- Every webhook requires HMAC-SHA256 auth via the `X-AWSops-Signature` header. Reject any ingest path that skips verification.
- Secret rotation keeps an active+standby pair; BOTH must validate during rotation (don't drop the standby).
- Same resource + same metric within the correlation window (default 5 min) must be deduplicated/grouped.
- AI diagnosis auto-fires ONLY on `high`/`critical` severity — this is a cost control, not an optional optimization. Widening the trigger is a flag-worthy change.
- Alerts with no explicit Slack channel mapping fall back to the default channel (never silently drop).

## v1 scope note
This module lives under `src/` (the v1 app: CDK/EC2/Steampipe). v1 conventions apply here and differ from v2 (`web/`, `terraform/v2/`):
- Pages start with `'use client'`; component imports are default exports.
- All fetch URLs use the `/awsops/api/*` prefix (the v2 root-path `/api/*` rule does NOT apply).
- CloudWatch-metric APIs invoke the AWS CLI via `execFileSync` (no shell — guards against injection).
