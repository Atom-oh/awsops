# Design: ExternalId-optional + Steampipe all-region inventory fan-out

- **Date**: 2026-06-26
- **Branch**: `feat/v2-externalid-optional-region-fanout` (off `feat/v2-architecture-design`)
- **Status**: Draft for review

## Context & motivation

v1's account connection was simpler than v2's: you connected an IAM role (no
ExternalId) and Steampipe queried **all regions** (`regions = ["*"]`). v2
regressed on both axes — ExternalId is mandatory, and inventory is hardcoded to a
single region (`ap-northeast-2`).

The multi-region **model + UI** is already shipped on `feat` (the
`account_regions` table, `/api/accounts/regions` route, `lib/account-regions.ts`,
and the accounts-page scope selector — merged via PR #108/#109). This spec covers
**only the two remaining gaps** needed for v1 parity. It does not re-design the
already-merged region model.

## Goals (the two gaps)

1. **ExternalId optional** — add/verify a cross-account connection without an
   ExternalId (the 1st-party case). When an ExternalId *is* supplied, behavior is
   unchanged (passed to `AssumeRole`, enforced by the target role's trust policy).
2. **Steampipe all-region + multi-account inventory fan-out** — inventory /
   security / compliance read across **all enabled accounts × their enabled
   regions** (from `account_regions`), like v1's `regions = ["*"]`, by generating
   the Steampipe connection config at container start.

## Non-goals

- AgentCore live-query (chat) multi-region fan-out — separate effort "C".
- Re-designing the `account_regions` model/UI (already shipped).
- Any AWS-resource mutation. This broadens **read-only** inventory only; ADR-005
  (mutation/autonomy FROZEN) is untouched.

---

## Gap 1 — ExternalId optional

### Changes

- **`web/app/api/accounts/route.ts`**
  - Remove the `if (!externalId) return err('externalId is required …', 400)`
    guard (line ~42).
  - Pass `ExternalId` to the verification `AssumeRoleCommand` **only when
    non-empty**.
  - Persist `NULL` (not `''`) into `accounts.external_id` when empty.
- **`web/lib/aws-assume.ts`**
  - Replace `if (!acct.externalId) throw …` (line ~32) with a conditional:
    include `ExternalId` in the `AssumeRoleCommand` only when present; otherwise
    assume without it. The cache key already concatenates `arn | externalId`
    (empty segment when absent), so no cache-collision risk.
- **`agent/lambda/cross_account.py`** — already conditional
  (`if _EXTERNAL_ID: assume_params['ExternalId'] = _EXTERNAL_ID`). No change;
  covered by a regression assertion.
- **`web/app/accounts/page.tsx`** — ExternalId input no longer required (drop the
  required marker / client-side block). Helper text: *"Optional — required only
  if the target role's trust policy enforces `sts:ExternalId` (recommended for
  3rd-party / shared accounts)."*

### Behavior

- Add account, **no** ExternalId → verify runs `AssumeRole` without `ExternalId`
  → succeeds iff the target trust policy has no `sts:ExternalId` condition →
  stored `verified`, `external_id = NULL`.
- Add account **with** ExternalId → unchanged from today.

### Tests

- `web/app/api/accounts/route.test.ts` — add-account success with no externalId
  (mock STS assume OK); existing with-externalId path still passes; empty string
  persists as `NULL`.
- `web/lib/aws-assume.test.ts` — assume **without** externalId omits the
  `ExternalId` param; **with** externalId includes it; cache keys stay distinct.

---

## Gap 2 — Steampipe all-region / multi-account inventory fan-out

Decisions taken in brainstorming: **① entrypoint self-generates `aws.spc`**;
**② inventory covers all enabled regions** (the form's per-account region is only
a default/display value).

### Approach

Replace the baked static `aws.spc` with a config generated at container start
from Aurora — the same mechanism class v1 used (Steampipe connection config), so
**no inventory SQL changes**.

- **`scripts/v2/steampipe/Dockerfile`**
  - Add a minimal Postgres client for the entrypoint (`python3` + `pg8000`, or
    `postgresql-client`).
  - Replace the static `COPY aws.spc …` + direct `steampipe service start`
    ENTRYPOINT with a wrapper `gen-spc-and-start.sh`.
- **`scripts/v2/steampipe/gen-spc-and-start.sh`** (new)
  1. Read Aurora creds from the secret ARN env (same secret the sync path uses);
     connect.
  2. Query enabled accounts joined to their enabled regions:
     ```sql
     SELECT a.account_id, a.alias, a.role_name, a.external_id, a.is_host,
            COALESCE(array_agg(r.region) FILTER (WHERE r.enabled), '{}') AS regions
       FROM accounts a
       LEFT JOIN account_regions r ON r.account_id = a.account_id
      WHERE a.enabled
      GROUP BY a.account_id, a.alias, a.role_name, a.external_id, a.is_host;
     ```
  3. Render `/home/steampipe/.steampipe/config/aws.spc`:
     - One connection per account:
       `connection "aws_<sanitized>" { plugin = "aws@0.142.0"; regions = [<enabled regions, or ["*"] if none>]; ` then for **non-host**: `role_arn = "arn:aws:iam::<acct>:role/<role_name>"` and, only when set, `external_id = "<value>"` `}`.
       Host account uses the task role's default chain (no `role_arn`).
       Connection name sanitized to `^aws_[a-z0-9_]+$`.
     - Aggregator so existing `aws.*` queries transparently span every account +
       region: `connection "aws" { type = "aggregator"; connections = ["aws_*"] }`.
  4. `exec steampipe service start --database-listen network --database-port 9193 --foreground`.
- **`terraform/v2/foundation/steampipe.tf`** — steampipe task role gains, all
  `steampipe_enabled`-gated:
  - read on the Aurora secret (the sync Lambda already has this; the steampipe
    task does not — add);
  - `sts:AssumeRole` on `arn:aws:iam::*:role/<role_name>` (scoped to the role-name
    pattern) for cross-account connections;
  - (Aurora reachability already satisfied — task is in the VPC.)
- **Regen trigger** — on account/region add/remove, the BFF
  (`/api/accounts`, `/api/accounts/regions`) calls
  `ecs update-service --force-new-deployment` on the steampipe service so the
  entrypoint regenerates. Requires `ecs:UpdateService` on the steampipe service
  ARN for the web task role (gated). *Fallback if we want to avoid web→ECS
  coupling: regeneration is eventual — it happens on the next task restart/deploy;
  immediacy is the only thing lost.*
- **`scripts/v2/steampipe/sync_lambda.py`** — no SQL change. The aggregator spans
  accounts + regions; rows already carry `region` / `account_id`. Note: result
  volume grows ≈ (#accounts × #regions); acceptable, and bounded by
  `steampipe_enabled`.

### Tests

- Pure render function `render_spc(rows) -> str` unit tests:
  - host-only (no `role_arn`, no `external_id`);
  - non-host **with** `external_id`;
  - non-host **without** `external_id` (line omitted);
  - multi-region list rendering;
  - empty-regions → `["*"]` (parity fallback);
  - alias sanitization → valid connection name.

### Dependency

- Builds on `account_regions`, already in `feat` (PR #109). **No new schema
  migration** — `accounts.external_id` is already nullable, and Gap 2 only reads
  existing tables.

---

## Rollout & safety

- Entirely read-only; no AWS-resource mutation (ADR-005 untouched). Broadening
  regions only increases inventory reads. Cost: more Steampipe queries; bounded by
  the `steampipe_enabled` gate (live = true).
- Backward compatible: an account with no `account_regions` rows falls back to
  `["*"]` (or its host default), so existing single-region behavior is a strict
  subset.
- ExternalId change is backward compatible: existing accounts keep their stored
  ExternalId and continue to send it.

## Out of scope / follow-ups

- AgentCore chat live-query multi-region ("C").
- Confirm Powerpipe/compliance inherits the aggregator fan-out for free (same
  `aws.spc`); if not, a follow-up wires it.
