# Runbook: v1 Decommission

Use with [ADR-016](../decisions/016-v1-decommission.md). Owner **Junseok Oh** directed retirement
**2026-07-09** and approved early code removal **2026-07-12**. This is operator-directed work, not
an autonomous product capability or a new approval to repeat historical destruction.
Repository procedures checked **2026-09-13**; **no live AWS status was reverified** by this audit.

## Recorded status

| Phase | Dated evidence |
|---|---|
| 0–3 | Retirement decision, data/user/alert review, domain cutover, EC2 stop, and CloudFront disable recorded 2026-07-09 |
| 5 | Code removal completed 2026-07-12 under owner override before final AWS deletion; restore tag `v1-pre-code-removal-20260712` |
| 4.1–4.3 | Stack/ALB/SQS cleanup recorded complete 2026-08-25 |
| 4.4/4.5 | **Unconfirmed as of 2026-08-27**: the prior ALL CLEAR used an incomplete Lambda list; corrected-list verification still required |
| 6 | Historical docs-site archival tracked separately; not audited or declared complete here |

Preserve shared VPC/NLB/hosted-zone/CDKToolkit resources, docs-site DNS, spoke `AWSopsReadOnlyRole`,
and all v2 resources. v2 uses those spoke roles for implemented multi-account reads. A resource prefix
is a discovery filter, never sufficient authority for deletion.

<a id="phase-1"></a>
## Phase 1 — Data, users, and alert senders

Selected history imports use [the backfill runbook](v1-to-v2-aurora-backfill.md). ADR-016 records the
**2026-07-09** completed import and accepted exclusions: config/department ACL/branding/credentials,
conversation history, AgentCore statistics, and schedules were not imported or S3-archived. Do not
invent a requirement to recover intentionally excluded data as part of unrelated v2 development.

Reconcile Cognito users against the historical roster. Do not infer identity from a reassigned mailbox
or bulk-set verified-email flags. Confirm the address belongs to the intended person, still belongs
to them, and should receive any matching admin allowlist authority. `email_verified` is an assertion,
not lasting operator control: users can verify an address already placed on their account. If an
address cannot be established, do not create the account with it. Follow
[user offboarding](user-offboarding.md) for existing incorrectly assigned/departed users.

Public signup/email changes/recovery are separately controlled by ADR-002. Passwords cannot migrate
between pools. Updating a verified claim affects newly issued tokens; existing tokens need revocation
where immediate cutoff is required.

The self-hosted login does not complete Cognito challenges such as `NEW_PASSWORD_REQUIRED`.
An admin-created account left in `FORCE_CHANGE_PASSWORD` cannot finish sign-in. An authorized
operator must finish provisioning its permanent password through the approved credential-delivery
procedure; do not promise an in-app first-login password-change flow.

Check external webhook and native SNS/SQS senders separately. Empty app-log grep does not prove no
traffic. The **2026-07-09** evidence was native subscriptions/alarms/queue depth plus actual v1
`alertDiagnosis` OFF; it did not prove external sender configurations absent. Current v2 supports
SNS signature/TopicArn verification and direct bearer/HMAC ingress behind the lifecycle gate; the
old assertion that it rejects every SNS Notification for lack of HMAC is obsolete. A v2 webhook is
still not a drop-in consumer for an old SQS queue. Record migration or explicitly approved loss of
any sender before retiring its receiver.

<a id="phase-2"></a>
## Phase 2 — Historical domain cutover

This phase was executed **2026-07-09**. Do not repeat the old singleton-to-for_each code edits: the
current origin Terraform root already models aliases. The historical operation added certificate
SANs, moved the CloudFront domain association, remapped/imported Route53 state, then applied a fresh
plan for DNS/Cognito URLs. Health/login checks for both domains were recorded successful.

The actual domain move used `cloudfront update-domain-association`, not the superseded
`associate-alias` recipe. It deliberately skipped redeploying the old CDK stack because of instance,
secret-parameter, and network-context risk. Import did not remove CFN ownership; the recorded deletion
mitigation was retaining `DomainARecord`. This is historical evidence, not general permission for dual
IaC ownership. Any remaining DNS change needs current configuration/state review and a new saved plan.

```bash
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation plan -out tfplan
```

The controller applies only the reviewed saved plan. Validate the actual current public URL and
Cognito callbacks; do not assume old domain strings or resource IDs.

<a id="phase-3"></a>
## Phase 3 — Historical dark/grace period

The **2026-07-09** record verified EC2 stopped and observed CloudFront disable propagating. Stop is
not terminate, and an in-progress distribution update is not completed deletion. The accepted grace
window was one to two weeks before final AWS deletion. If restoring from historical infrastructure,
review current resources first; a rollback must align CloudFront alias association **and** Route53
target, plus Terraform ownership. Code restoration cannot recreate deleted AWS resources.

<a id="phase-4"></a>
## Phase 4 — Verify remaining teardown

The checked-in helper owns the enumerated orphan Lambda, AgentCore target/gateway/memory/interpreter,
and versioned deployment-bucket procedure. It verifies but does **not** delete leftover ALB/SQS.
It is pinned to the historical account/region and requires that CloudFormation teardown is already
complete. Inspect its guards and explicit resource lists before use; do not weaken them to fit another account.

### 4.1–4.3 — Stack and edge checks

These phases were recorded complete **2026-08-25**. Verify current state rather than rerunning deletes:

```bash
aws cloudformation list-stacks   --query "StackSummaries[?contains(StackName,'Awsops') && StackStatus != 'DELETE_COMPLETE']"
# Lambda@Edge is managed separately in us-east-1.
aws lambda list-functions --region us-east-1   --query "Functions[?FunctionName=='awsops-cognito-auth'].FunctionName"
```

A remaining edge function needs all distribution associations/replicas removed before deletion.
A remaining stack needs resource/retention review, especially the imported `DomainARecord`.
Do not redeploy a removed v1 CDK tree to satisfy this historical procedure.

### 4.4/4.5 — Corrected-list dry-run, then separately approved execution

On **2026-08-27**, source comparison found `awsops-istio-mcp` and `awsops-datasource-diag-mcp` missing
from the **2026-08-25** list: 19 became 21 Lambda names. Whether the omitted functions actually existed
on that date was not established. The earlier ALL CLEAR is insufficient until the corrected list is
checked. The helper's arrays are authoritative for its scope; unknown resources require individual triage.

```bash
# Force preview mode even if a prior shell exported the confirmation variable.
env -u AWSOPS_V1_TEARDOWN_CONFIRM bash scripts/v2/teardown/v1-teardown-4.4-4.5.sh
```

Review actual caller/account, region, every candidate, unexpected inventory, and inaccessible resources.
An auth/throttling/read failure is **indeterminate**, never "already deleted." Once the exact preview
is approved, the operator can run the separate destructive invocation:

```bash
AWSOPS_V1_TEARDOWN_CONFIRM=yes bash scripts/v2/teardown/v1-teardown-4.4-4.5.sh
```

The helper drains gateway targets before gateways and handles versioned bucket objects/delete markers.
Deleting a versioned bucket needs that complete drain, not just `aws s3 rm --recursive`. Preserve its
bounds/failures and review CloudTrail/command results; no documentation flag substitutes for review.

### Residue outside helper deletion scope

If the helper reports a remaining ALB/SQS resource, confirm it is v1-owned and outside any surviving
stack before separate operator cleanup. For ALB, discover target groups **before** deleting the load
balancer; remove listeners, then ALB, then the recorded groups. For SQS, confirm sender review and
queue ownership, then main queue before DLQ. Never sweep by broad prefix.

```bash
aws elbv2 describe-load-balancers --names awsops-alb
aws sqs get-queue-url --queue-name awsops-alert-queue
aws sqs get-queue-url --queue-name awsops-alert-dlq
```

Only explicit not-found results establish absence. Check v2 health and a target-account chat read
before reporting completion. The helper excludes AgentCore `DELETING` entries from its residual
count; that indicates requested deletion, not proof of physical completion. Record pending asynchronous
resources honestly and recheck when they settle.

<a id="phase-5"></a>
## Phase 5 — Code cleanup record

Completed **2026-07-12** by owner override, before AWS teardown. Tag
`v1-pre-code-removal-20260712` and commit `0a12b79b` preserve the removed tree. Imported v2 agent/RCA
modules and active tests were retained. PR #159 subsequently moved remaining root package dependencies
into `scripts/v2/`; no root package manifest is expected. Do not delete retained code on the strength
of the old proposed removal list.

<a id="phase-6"></a>
## Phase 6 — Docs-site archival is separate

The prior record cites PR #193 banners for `compute/eks-auth.md` and `compute/ecs-container-cost.md`
and an unfinished broader audit. It does not establish today's completion or a reliable remaining-page
count. Multilingual user guides remain multilingual. Changes to their archival status belong to the
separate docs-site owner, not this operational runbook update.

## Related

[ADR-016](../decisions/016-v1-decommission.md), [ADR-011](../decisions/011-multi-account.md),
`docs/history/v1-v2-gap-audit-2026-07-09.md`, `scripts/v2/teardown/v1-teardown-4.4-4.5.sh`.
