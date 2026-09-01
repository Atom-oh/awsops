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
  uses it). Absent names render the table's standard em-dash.
- **L188** — `cloudtrail` spec gains a `last_delivery_h` column (localized datetime via the
  existing `dateH` deriver pattern from `latest_delivery_time`, already synced) — an
  at-a-glance "is this trail actually delivering" signal.
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
