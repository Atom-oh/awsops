# ADR-019 S3 Permission Provenance

Historical evidence for the 2026-09-13 documentation clarification, not a new IAM grant or
an architecture-decision amendment. The accepted ADR-019 text before condensation is retained at
commit `4234dadf9cb2df40927c0ac486163666f1911aa2`, `docs/decisions/019-athena-flow-log-query-classification.md` (English Decision section, lines 236–249).

The original permitted-operations list contained this exact excerpt:

> - `s3:GetBucketLocation`
> - **`s3:GetObject`, `s3:ListBucket` (source location) — scoped to the spec §IAM's "configured Flow
>   Log table locations" (the actual source data location the Glue table points at). This is the
>   data the SQL query actually reads, and it is a distinct location from the result prefix below
>   (potentially a different account/bucket entirely).**
> - **`s3:GetObject`, `s3:ListBucket`, `s3:PutObject`, `s3:AbortMultipartUpload` (result prefix) —
>   scoped ONLY to the customer workgroup's own pre-configured result prefix. The write half
>   (`PutObject`/`AbortMultipartUpload`) is a required mechanic of running an Athena query at all
>   (§3's "the service's own internal mechanism" argument is precisely about this grant). **The read
>   half (`GetObject`/`ListBucket`) is ALSO required on this same prefix** — Athena itself reads back
>   the result objects it wrote, both to serve `GetQueryResults` and (when enabled) to evaluate query
>   result reuse. The source location and the result prefix remain distinct locations, but the result
>   prefix itself needs both read and write — write-only would not actually work.** AWSops never
>   writes outside this prefix and never creates or deletes that bucket/workgroup.

`GetBucketLocation` was a standalone permitted action, separate from the explicitly scoped
source-object and result-object operations. The initial condensed table placed that existing
action only in its source row; the corrected table gives bucket metadata its own row for the
configured source and result buckets. It adds no new action and does not relax object-prefix
limits, role isolation, ExternalId, generated-SELECT constraints, or the prohibition on bucket
and workgroup administration.

This record does not assert that a customer role was changed or deployed. Current policy remains
[ADR-019](../decisions/019-athena-flow-log-query-classification.md) and the decision baseline.
The [original version](https://github.com/Atom-oh/awsops/blob/4234dadf9cb2df40927c0ac486163666f1911aa2/docs/decisions/019-athena-flow-log-query-classification.md) supplies the full
surrounding trust, query and exclusion conditions.
