# Inventory quick wins: CloudFront Name, CloudTrail delivery fields, ECR encryption — 4 gap-audit items (L187, L188, L189, L213)

**Status:** Batch 22, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch22`.
**WA pillar:** Operational Excellence / Security (at-a-glance signal completeness).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L187 (CloudFront table Name column),
L188 (CloudTrail Last Delivery column), L189 (CloudTrail detail delivery/stop fields),
L213 (ECR encryption-type column).

## Decisions
- **L187** — `cloudfront` spec gains `{ key: 'name', label: 'Name' }` as the second column
  (the value is already synced via `(tags->>'Name') AS name`; the DetailPanel header already
  uses it). Absent names render as blank cells (DataTable's null rendering).
- **L188** — `cloudtrail` spec gains a `last_delivery_h` column (UTC datetime — the header
  carries the (UTC) marker; the deriver normalizes the persisted space-separated pg8000
  timestamp before parsing) — an at-a-glance "is this trail actually delivering" signal.
  Note: it is a last-SUCCESS timestamp; `latest_delivery_error` (detail panel) is the failure
  signal.
- **L189** — the cloudtrail sync SELECT gains 6 columns, all verified present in the pinned
  plugin `aws@0.142.0` (`table_aws_cloudtrail_trail.go`): `cloudwatch_logs_role_arn`,
  `latest_cloudwatch_logs_delivery_time`, `latest_cloudwatch_logs_delivery_error`,
  `latest_digest_delivery_time`, `latest_digest_delivery_error`, `stop_logging_time` —
  surfaced in the detail Logging/Storage sections (lockstep query test; rows carry them after
  the next sync run, sections skip absent keys — honest degrade).
- **L213** — the `ecr` deriver gains `encryption_type_h` from
  `encryption_configuration ->> encryption_type` (case-insensitive `walk`; AES256/KMS), added
  as a table column and to the detail Security section; the raw blob stays visible.

No Terraform/IAM/schema changes (the new sync columns live in the existing `data` JSONB).

## Testing
- Sync: cloudtrail query lockstep test for the 6 new columns.
- Derived: ecr `encryption_type_h` (AES256/KMS/absent), cloudtrail `last_delivery_h` (date
  formatting + absent → undefined).
- Registry: columns present in the specs (existing registry invariant tests keep passing).
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-22 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **The docs-site ECR guide contradicted the shipped UI (the gate MAJOR)** — all four locales
  said "the encryption type is not a table column"; the sentence and the column tables now
  document the Encryption column. The CloudTrail guides (4 locales) mention the Last Delivery
  (UTC) column.
- Last Delivery is labeled (UTC) and moved into the mobile card window; the deriver
  normalizes the real persisted timestamp shape (space-separated pg8000 str()) with a test in
  that shape; CW-Logs delivery time/error joined the Logging section beside the S3/digest
  evidence (plumbing stays in Storage); `last_delivery_h` is hideKeys'd from the panel
  (table-only derivation of `latest_delivery_time`); the two dead VIRTUAL_LABELS entries are
  removed (table columns resolve from spec.columns); CloudFront's Name column moved before
  Domain, matching the published guide order.
