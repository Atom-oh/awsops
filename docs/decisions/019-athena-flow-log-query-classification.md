# ADR-019: Constrained Athena Queries Are Inside the Read-Only Invariant

## Status

Accepted **2026-08-19**, owner-directed with multi-AI review.
**Junseok Oh** directed drafting/review in the co-agent consensus session and explicitly approved
acceptance after the two Major findings were corrected. Two independent review rounds used Codex
(`openai.gpt-5.5`) and Kiro (`claude-fable-5`); Agy did not ingest the review. The corrections explicitly
approved prefix-scoped result-object writes and made Athena's read-only property conditional on controls.
Role separation was also corrected **2026-08-19**. Repository evidence checked **2026-09-13**.

This resolves the classification question in the **2026-08-13** SG Rules design. It is **not an
ADR-005 exception or an ADR-007 broad-write grant**. Historical planning language requiring an
additional override does not reopen the question this accepted decision settled.

## Context

SG activity reads Flow Logs through customer-configured Athena/Glue/S3. Query execution creates
result objects, but the product neither modifies SG rules nor administers the source infrastructure.
`athena:StartQueryExecution` is write-capable in general; its name alone does not establish read-only behavior.

## Decision

The SG Rules inventory/activity pipeline is inside the existing read-only invariant **only while all
three controls hold**:

1. Submit only server-generated SELECT over validated schema/partitions. Never execute arbitrary
   user/operator SQL, expressions, or a caller-supplied query under the broker's credentials.
2. Exclude mutating Glue/workgroup administration privileges.
3. Scope S3 reads to registered source locations and the configured result prefix; scope writes to
   that result prefix only. No object deletion or bucket/policy/ACL administration.

`sg_rule_activity_enabled` is ordinary GATED, default false, and requires workers. A policy that
satisfies this ADR is not proof that the feature has been deployed or enabled.

### Role A: rule inventory

Reuse `AWSopsReadOnlyRole` for EC2 rule/interface/Flow Log descriptions under ADR-011's trust model.
Do not attach Athena or S3 result-write privileges to it. The optional worker principal is a separate
onboarding change, not an expansion of this role into a write-capable role.

### Role B: isolated Athena query access

Use `AWSopsSgRuleAthenaRole` in the target account. Its trust requires **both** an explicit host
Athena-principal restriction **and ExternalId**. Do not copy ADR-011's optional first-party ExternalId
rule to this more capable role. The implementation chose a dedicated **broker Lambda**; the shared
worker/web roles can invoke the broker but cannot directly assume the Athena role.

Permitted operations, with their scopes intact:

| Service | Operations / scope |
|---|---|
| Athena | `StartQueryExecution`, `GetQueryExecution`, `GetQueryResults`, `StopQueryExecution`, `GetWorkGroup`; constrained workgroup and generated SELECT |
| Glue | `GetDatabase`, `GetTable`, `GetPartitions`; validated source catalog |
| S3 source | `GetBucketLocation`, `GetObject`, prefix-scoped `ListBucket` for configured Flow Log source locations |
| S3 results | `GetObject`, prefix-scoped `ListBucket`, `PutObject`, `AbortMultipartUpload` on the customer workgroup's preconfigured result prefix |

Result reads are necessary to retrieve/reuse query output; result-prefix writes are explicitly
accepted query mechanics. Source and result locations can differ and must not be conflated.
Excluded: workgroup/Glue creation, mutation, or deletion; object deletion at any prefix; writes outside
the result prefix; bucket-policy/ACL writes; EC2 mutation; role creation/PassRole for these assumed
query roles; and shared-worker direct assume access. Customer lifecycle configuration owns cleanup.

### Actual broker behavior

`sg_rule_athena_broker.py` resolves registered source/day requests from Aurora and generates SQL itself.
Validation and execution enforce workgroup scan cutoff/budget requirements; continuation must remain
bound to the source/query/workgroup. Unknown Glue partition state stalls the day/watermark rather than
committing false "no observed evidence." This is a deliberate availability/correctness tradeoff.

The old choice between a dedicated task and a broker is settled in code: `sg-rules.tf` provisions the
broker. Network Path Check is a separate read-only feature and does not depend on this classification.

## Consequences

The decision permits bounded query processing without inventing a new external-write tier. Role B
still exposes scoped write capability if compromised; it does not have the same residual risk as its
read-only sibling. SQL constraints, role isolation, trust conditions, and S3 scopes are load-bearing:
a change to any of them cannot rely on this ADR as blanket approval. Query cost remains budgeted even
though the product operation is read-only.

## Six Pillars

Security: isolated query credentials, strict trust, generated SQL, and distinct source/result scopes.
Reliability: honest partition uncertainty and bounded query cancellation. Operational Excellence:
settled classification with auditable owner/panel evidence. Cost: scan cutoffs and gated daily processing.

## Evidence

`terraform/v2/foundation/sg-rules.tf`, `scripts/v2/workers/{sg_rule_scan,sg_rule_athena_broker}.py`,
`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md` (accepted-design provenance),
ADR-005/007/011, and BASELINE §2.
