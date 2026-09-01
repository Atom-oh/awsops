# OpenSearch missing sync columns + RDS SG inbound-rule chaining — 2 gap-audit items (L153, L154)

**Status:** Batch 16, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch16`.
**WA pillar:** Security (SG rule visibility) / Operational Excellence (update availability,
endpoint policy readability).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L153 (OpenSearch detail-panel fields
missing from sync), L154 (RDS detail-panel security-group inbound-rule chaining).

## Decisions

### L153 — OpenSearch sync columns (8)
- **Sync** (`scripts/v2/steampipe/sync_lambda.py` opensearch SELECT): add
  `service_software_options` (update availability — operationally important),
  `log_publishing_options` (per-log-type CloudWatch log groups), `domain_endpoint_options`
  (EnforceHTTPS / TLS policy / custom endpoint), `auto_tune_options`, `snapshot_options`,
  `advanced_options`, `access_policies`, `upgrade_processing`. All eight verified present in
  the pinned Steampipe plugin `aws@0.142.0` (`table_aws_opensearch_domain.go`); v1's
  `off_peak_window_options` does NOT exist in 0.142.0 and is deliberately excluded (noted on
  the audit tick).
- **Derived fields** (`inventory-derived.ts`): `software_update_h` ("update available:
  cur → new" / "up to date (cur)"), `enforce_https_h` (boolean), `tls_policy_h`,
  `custom_endpoint_h`, `auto_tune_h` (state), `snapshot_hour_h` (automated snapshot start
  hour). Fully-derived raw blobs (`service_software_options`, `domain_endpoint_options`,
  `snapshot_options`) are hidden via `hideKeys`; partially-derived or reference blobs
  (`log_publishing_options`, `advanced_options`, `access_policies`, `auto_tune_options`)
  stay visible (info availability — the L150 round-1 lesson).
- **Sections**: Engine += software update/upgrade state; Endpoint & Network += HTTPS/TLS/custom
  endpoint; Security += access_policies; new Operations section (auto-tune, snapshot hour,
  log publishing, advanced options).
- Rows sync these columns only after the next sync-lambda image deploy + sync run — sections
  skip absent keys, so pre-deploy rows simply render without the new fields (honest degrade,
  no code dependency on the deploy order).

### L154 — RDS SG inbound-rule chaining
- **Route** `GET /api/inventory/security_group/inbound?ids=sg-1,...&account=&region=` (clones
  the `ebs_volume/related` precedent): pure cross-query over the already-synced
  `security_group` inventory rows — NO live AWS call. Per SG id (≤20, charset-validated):
  `{sgId, found, groupName, rules: [{protocol, portRange, sources: [{kind: cidr|sg|pl,
  value, description}]}]}` parsed from the `ip_permissions` JSONB (case-insensitive key
  lookup — Steampipe JSONB carries the raw AWS PascalCase shape). Host account normalized via
  the 'self' sentinel (the documented self-vs-real-id trap). An SG absent from inventory
  returns `found: false` (rendered as "not synced", never an empty-rules claim).
- **UI** `RdsSgRulesSection` (named export, mounted in DetailPanel for rds rows below
  RdsTrendsSection): parses SG ids from the row's `vpc_security_groups`, one card per SG —
  group id + name header, inbound rules as protocol / port-range / source chips (CIDR with
  description, referenced SG pair, prefix list), v1's 'No inbound rules' empty state, inline
  error on fetch failure, "not synced" for unfound SGs.

No Terraform/IAM/schema changes (the sync lambda's Steampipe read and the BFF's Aurora read
are existing paths; new sync columns live inside the existing `data` JSONB).

## Testing
- Sync: opensearch query registered with the 8 new columns (lockstep test).
- Route: happy path (rules parsed: tcp port range, -1 all-traffic, CIDR description, SG pair,
  prefix list), not-found SG → found:false, id charset/limit → 400, account normalization,
  region narrowing, empty ip_permissions → rules: [].
- Derived: each new `*_h` (update-available vs up-to-date, EnforceHTTPS string/bool, absent
  blobs → undefined).
- Component: cards render rules + sources, 'No inbound rules', not-synced state, fetch error.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-16 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **`software_update_h` derives from `UpdateStatus`, not `UpdateAvailable`** — `UpdateAvailable:
  false` also covers `IN_PROGRESS` and the persistently unhealthy `NOT_ELIGIBLE` (domain must
  upgrade before it can receive updates), so the old "up to date" label asserted a falsely
  healthy state in exactly the cases an operator needs to see. Status-driven labels:
  COMPLETED → up to date; IN_PROGRESS/PENDING_UPDATE → update in progress; NOT_ELIGIBLE →
  not eligible — domain upgrade required; ELIGIBLE → update available; unknown statuses pass
  through verbatim. The raw `service_software_options` blob is also VISIBLE again (Operations
  section, out of hideKeys) so the label can always be cross-checked.
- **ICMP port formatting** — From/ToPort carry ICMP type/code (-1 = any); rules now render
  `type 8`, `all types`, `type 3/code 4` instead of a garbled "8--1" range.
- **`docs/api-reference.md` + route counts** — the new route is indexed and the exhaustive
  97→98 count is bumped in all seven declaration sites (api-reference ×2, README ×4-ish,
  root CLAUDE.md, web/app/CLAUDE.md).
