# ADR-016: v1 Decommission

## Status

Accepted by **Junseok Oh, 2026-07-09**, directing retirement of v1 in favor of v2.
This is operator-directed retirement, not an ADR-005 autonomous-product exception.
The owner separately authorized early repository cleanup on **2026-07-12**, before AWS teardown.
No additional cleanup or destruction is authorized by this documentation rewrite.

## Context

Running both versions duplicated cost, authentication, state, and deployment maintenance. The
**2026-07-09** gap review accepted remaining gaps as intentional drops or backlog; external alert
sender dependencies still required investigation. Historical branch warnings that `main` predates v2
are obsolete. Review against the actual checkout/base, using current ADR numbering.

## Decision

Retire v1 in stages: document scope and gaps; preserve selected data and reconcile users/alert ingress;
move the established domain to v2; stop/disable v1 with an observation window; delete only approved
v1 AWS resources; remove v1-only code. The **2026-07-12** owner override advanced code removal ahead
of final AWS deletion because git restoration was independent of the AWS rollback window.

Accepted data exclusions remain: v1 config/department ACL/branding/credentials, conversation history,
AgentCore statistics, and report schedules were outside backfill and were not S3-archived. Passwords
could not be migrated between Cognito pools. These losses were explicitly owner-approved, not new decisions.

Preserve spoke `AWSopsReadOnlyRole`, shared VPC/hosted-zone/CDKToolkit resources, and all v2 resources.
The target read-only roles support v2 multi-account operation. Retained v2 agent/RCA modules and tests
must be judged by actual imports, not deleted merely because an old cleanup plan called them v1-only.

## Dated execution evidence

These records describe past observations only. The runbook owns executable steps; this section is not
current authorization to replay them.

| Date | Recorded action / evidence | Limit |
|---|---|---|
| 2026-07-09 | Backfill completed: inventory scanned 26 snapshots/inserted 693 rows; cost scanned/inserted 24; no errors. Alert/scaling source data was absent | Historical import, not a current inventory count |
| 2026-07-09 | Cognito reconciliation found only the same placeholder user in the v1 pools and v2; no user creation/reset needed | Observation at retirement time |
| 2026-07-09 | Native alert checks found only the app's SQS subscriber, no alarm using that topic, and empty queues. Backfilled config had `alertDiagnosis` absent, so the v1 handler returned 503 before processing | Log grep alone was insufficient; absence of `alertSources` was not a safe gate. External sender configurations were not proven absent |
| 2026-07-09 | Domain cutover: certificate SANs, CloudFront domain association, Terraform alias state remap/import, then alias/Cognito URL apply. Both domains passed health/login checks | The v1 Route53 record remained in CFN ownership; deletion needed explicit retention of `DomainARecord` |
| 2026-07-09 | EC2 stop verified; CloudFront disable submitted and observed propagating; domains still reached v2 | EC2 was stopped, not terminated; disable was not recorded fully deployed |
| 2026-07-12 | Owner override moved code cleanup earlier. Restoration tag `v1-pre-code-removal-20260712`; removal commit `0a12b79b`. Retained imported v2 agent modules/tests. Recorded merge verification passed | Repository removal did not delete AWS resources; subsequent PR #159 moved remaining root dependencies into `scripts/v2/` |
| 2026-08-25 | Phase 4.1–4.3: `AwsopsStack`, ALB/SQS deletion recorded complete. Phase 4.4/4.5 script reported ALL CLEAR using its original Lambda list | That list was incomplete |
| 2026-08-27 | Source comparison found omitted `awsops-istio-mcp` and `awsops-datasource-diag-mcp`; corrected the historical Lambda list from 19 to 21 | Whether either omitted function existed on 2026-08-25 was unverified; Phase 4.4/4.5 completion remained unconfirmed |

The **2026-07-09** cutover deliberately avoided redeploying the old CDK stack to change retention:
its instance defaults, unavailable prior secret parameter, and network context could have changed live
resources. Import affected Terraform state without transferring CFN ownership; the recorded mitigation
was no further v1 deploy and explicit record retention during deletion. This historical tradeoff is
not a general endorsement of dual IaC ownership.

As of the last recorded correction (**2026-08-27**), remaining orphan Lambda/AgentCore/deploy-bucket
cleanup required a corrected-list dry-run and verified rerun. **No new AWS verification was performed
on 2026-09-13.** Do not infer ALL CLEAR from code removal, an earlier incomplete script, or this rewrite.

## Consequences

Retirement removes duplicate operating burden while preserving explicit rollback/evidence boundaries.
Accepted data losses and potentially stale external sender configurations remain part of the record.
Refer to the unchanged historical review and runbook for detailed evidence; do not apply legacy
implementation rules to current v2 development.

## Six Pillars

Cost Optimization and Sustainability: retire duplicate resources. Operational Excellence: staged,
owner-directed changes with restoration points. Security/Reliability: preserve shared resources,
authentication boundaries, and evidence limits.

## Evidence

`docs/runbooks/v1-decommission.md`, `docs/history/v1-v2-gap-audit-2026-07-09.md`,
`scripts/v2/teardown/v1-teardown-4.4-4.5.sh`, tag `v1-pre-code-removal-20260712`, and ADR-001/011.
