# ADR-015: Own-Secret Rotation Restart Exception

## Status

**Accepted — explicit, dated owner-override exception to ADR-005.**

- **Owner sign-off: Junseok Oh, 2026-07-01.** Authorized this narrow self-restart only.
- **Panel evidence: PR #114, 2026-06-29**, Claude chair, Codex, kiro-opus, and kiro-kimi.
  The panel rejected the original "distinct category" framing as an implicit owner-only re-scope.
  Acceptance explicitly names an exception; it is not a routine scoping clarification.
- All other ADR-005 mutation/autonomy paths remain frozen. No new permission is granted by this rewrite.

Current ADR-015 is unrelated to **legacy ADR-015** (FinOps, now ADR-012); see ADR-MAPPING.

## Context

The recorded **2026-06-28** Aurora master-secret rotation caused web database authentication failures
observed **2026-06-29**. At that time ECS injected the password at task start, so a rolling restart
recovered service by reading the new secret.

**Repository fact, checked 2026-09-13:** `web/lib/db.ts` now creates IAM-auth tokens per connection as
`awsops_web`, and `workload.tf` grants the corresponding `rds-db:connect`. The old password-injection
failure is historical rationale, not current web authentication. The retained restart feature still
defaults off; this ADR does not require restoring password injection or enabling it.

## Decision

The **only** authorized autonomous mutation is an own-Aurora-master-secret rotation triggering
`ecs:UpdateService(forceNewDeployment=True)` on the host's **own web service**, under all these limits:

1. `secret_rotation_redeploy_enabled` remains default **false**.
2. Match the configured Aurora secret; missing/unidentified/nonmatching events skip the restart.
   The handler checks exact identity first and retains its documented normalized-name fallback;
   do not claim stronger matching than the implementation.
3. IAM grants `ecs:UpdateService` on exactly the web service ARN. IAM does **not** restrict this
   action to `forceNewDeployment`; restart-only behavior is enforced by Lambda code. This leaves a
   deliberately narrow but real write capability on that service.
4. Do not change the task definition, image, desired count, network, or resource specification.
   This is a rolling restart, not authorization for a code deployment or remediation executor.
5. Event delivery depends on a CloudTrail management-event trail. Skip paths are logged/alarmed;
   the trail and alarm delivery must be operationally verified before relying on the feature.

The exception does not cover other services, unrelated secrets, generic self-healing, or customer
infrastructure. A list-shaped implementation or stale expansion comment is not authority to widen it.
ADR-005's frozen remediation, arbitrary BYO-MCP, and mutating tools remain unchanged.

## Consequences

The historically accepted recovery avoided recurring password-rotation outages with one-service scope.
It still introduces an autonomous write path whose IAM is broader than its intended call parameters.
Current IAM-based web authentication removes the original task-start-password premise; retaining
this accepted, default-off exception is not a deployment recommendation.

## Six Pillars

Reliability: bounded recovery of the recorded failure. Security: one service, verified trigger,
unchanged specification, and explicit residual IAM scope. Operational Excellence: exact dated owner
and panel evidence rather than a general self-healing exemption.

## Evidence

`terraform/v2/foundation/secret-rotation.tf`, `scripts/v2/secret-rotation/redeploy.py`,
`web/lib/db.ts`, `terraform/v2/foundation/workload.tf`, PR #114, and ADR-005.
