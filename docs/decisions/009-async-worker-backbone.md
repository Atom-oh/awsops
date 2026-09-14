# ADR-009: Async Workers and Ownership-Safe Submission

## Status

Accepted **2026-06-22**. Consolidates the worker tier of legacy ADR-037; the mutating branch of
legacy ADR-036 is governed by ADR-005. Ownership/idempotency corrections from PRs #195/#203 remain
part of this contract. Repository evidence checked **2026-09-13**.

## Context

Long or memory-heavy work must survive request termination and retries without blocking the thin BFF.
A generic job endpoint must not let callers forge domain identifiers or another user's results.

## Decision

- Use Aurora `worker_jobs` as the ledger, followed by SQS, an event-source-mapping kill-switch,
  an idempotent dispatcher, and Step Functions. Short jobs use Lambda; long/OOM-prone jobs use
  `ecs:runTask.sync` Fargate. Workers write running/succeeded; Catch invokes the status-updater Lambda;
  the scheduled reaper reconciles stale jobs. Delivery is at least once, so handlers must be idempotent.
- `workers_enabled` defaults false. Domain gates are additional conditions. The shared worker tier
  and internal records do not authorize frozen AWS-resource remediation.
- Generic `POST /api/jobs` accepts only allowlisted `noop`/`noop-heavy`. Domain jobs use dedicated
  authorized routes or trusted internal dispatchers. Derive `requestedBy` from verified `sub`,
  scope idempotency keys to the caller, and enforce ownership on status/results/artifacts.
- Report submission uses `/api/diagnosis`; compliance uses `/api/compliance/run`. Schema/index and
  insight refreshes use their admin routes. Scheduled reports, FinOps, and SG scans have trusted
  internal dispatchers. The authoritative job list/runtime mapping is `handlers.REGISTRY`, with
  special incident-stage routing in `dispatcher.py`; an accepted type is not automatically public API input.
- `incident_stage` shares the ledger/SQS path but routes to the lifecycle state machine (ADR-006).
  `finops_baseline` and `sg_rule_scan` keep their domain gates (ADR-020/019).
  Network Path routes additionally reject new runs while
  `networkPathLiveTopologyCapabilityGate()` reports unimplemented. Cached topology discovery is
  not the complete live reread guarantee; viewing prior checks/runs is separate from starting one.
- Fargate worker images are arm64 and use `CMD`, since Step Functions supplies the command override.
  Domain handlers own artifact uploads; returning an artifact from a handler does not imply upload.

### Report idempotency and lineage

A job has at most one **live report link**: the unique index applies only where
`worker_job_id IS NOT NULL AND deleted_at IS NULL`; soft-deleted links do not reserve the slot.
A report named by the job payload remains the worker's input even if it lost the link race.
Soft-delete a ledger loser that the payload does not name; preserve a payload-named link loser.
Resolve idempotency and lineage through link **or payload**. Use owner-scoped lineage. BFF legacy dual-key matching can find an old
baseline; the schedule dispatcher only has its stored `user_sub`, so historical scheduled lineage can
remain null and is not retroactively repaired by ownership backfill.

### Ownership scope and carve-outs

Individual `worker_jobs`, `diagnosis_reports`, and `compliance_runs` rows, lists, results, and
downloads require owner-or-admin access. `requested_by IS NULL` denotes an internal enqueue
without an end-user principal and is admin-only on read.

Authenticated users may read the non-attributable fleet aggregates in `GET /api/overview`:
job counts by status and the latest succeeded CIS run's `pass_rate`, `alarm`, and `finished_at`.
This exception excludes `requested_by`, job/report IDs, report contents, and other identifying
row data. Fleet tiles may therefore differ from the caller's ownership-filtered compliance list;
the exception does not make individual runs public to other users.

The ownership backfill excludes administrative attribution columns `skills.created_by`,
`agents.created_by`, and `architecture_intent.created_by`. They are not general ownership keys;
the current diagnosis-intent route already writes `sub`, while skill/agent catalog writers use email.
`action_plans.created_by` is an authorization key and must use immutable `sub`: the 4-eyes
check uses `identityKeys()` and rejects legacy email-keyed creators when distinctness is unprovable.
These rules do not enable the frozen remediation path.

### Amendment — Ownership migration contract

New ownership writes use `sub`. `legacy_email_owner_match` defaults **true** and temporarily accepts verified
email for every `matchesIdentity()` gate, including report PATCH/DELETE. It is a migration switch,
not a default-off feature. Reassigned addresses remain a risk until the cutover actually completes.

The ordered termination steps retain the numbering used by runtime/runbook citations:

1. New user-ownership writes use immutable `sub`; the attribution exclusions above remain separate.
2. `make backfill-owner-sub` creates a **plan only**. Remove mappings the operator cannot
   establish historically; current Cognito email ownership alone is insufficient. Apply reviewed
   entries with `node scripts/v2/backfill-owner-sub.mjs --apply "$OWNER_BACKFILL_PLAN"`,
   after setting that variable to the reviewed plan file.
   Keep curated copies named `backfill-owner-sub-<name>.json`: the CLI enforces that
   gitignored basename pattern. Plans and journals contain email-to-sub mappings and row IDs;
   generated artifacts use mode `0600`, which reviewed copies must preserve.
   Cover `worker_jobs`, `diagnosis_reports`, `compliance_runs`, and `report_schedules`. Exclude
   unverified/unmapped/ambiguous addresses and conflicting target schedules. Reject missing or
   unparsable evidence and accounts created after the earliest owned row; an older account later
   receiving the address still requires operator judgment.
   Quiesce the schedule dispatcher, including in-flight executions. Apply only reviewed row IDs,
   revalidate both DB and Cognito identity, and use a single transaction. Journal actual changed IDs
   and distinguish attempted, committed, rolled-back, and unknown commit outcomes. Roll back by IDs,
   never a broad owner predicate; post-commit reporting failure is not a rollback.
3. Require a successfully completed `--apply` and verify zero residual legacy rows,
   then deploy `LEGACY_EMAIL_OWNER_MATCH=false` (`legacy_email_owner_match=false`).
   A clean preview is insufficient. The current `apply()` rejects empty plans with
   `has no entries` before verification, so it cannot supply completion evidence for a zero-entry
   first cutover. Without completed apply evidence and residual verification, keep the switch true.
   Supporting that empty-plan case needs a separately reviewed implementation; this ADR does not
   waive the apply requirement or present the currently rejected command as a working procedure.
   Resume scheduling only after the residual check; otherwise it can recreate email-keyed rows.

Use `scripts/v2/backfill-owner-sub.mjs` for executable plan/apply steps and
[user offboarding](../runbooks/user-offboarding.md) for access removal. This documentation update
is neither a migration apply nor evidence that the switch can be disabled.

## Consequences

One durable tier handles async work with eventual reconciliation, at the cost of retries, concurrency,
and lifecycle bookkeeping. Domain submission and ownership checks prevent generic payload IDOR.
Compatibility is deliberate but time-limited; only verified migration results close it.

## Six Pillars

Reliability: durable ledger, idempotency, failure handling, and reconciliation. Security: verified
submission/ownership and constrained jobs. Operational Excellence: explicit gates and migration evidence.

## Evidence

`terraform/v2/foundation/workers.tf`, `scripts/v2/workers/`, `web/app/api/jobs/route.ts`,
`web/lib/{jobs,diagnosis,auth,network-path-gate}.ts`, `scripts/v2/backfill-owner-sub.mjs`.
