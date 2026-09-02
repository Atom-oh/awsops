# Chart quick wins 3: compliance Alarms by Section, S3 Security Status, Subnets per VPC — 3 gap-audit items (L191, L240, L251)

**Status:** Batch 29, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch29`.
**WA pillar:** Security / Operational Excellence (posture legibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L191 (compliance Alarms by Section
bar chart), L240 (S3 Security Status bars), L251 (Subnets per VPC distribution).

## Decisions
- **L191** — `/compliance` gains an "Alarms by Section" `BarDistribution` beside the status
  donut and the pass-rate section list, fed by the SAME client-side per-section rollup the
  pass-rate list already computes (no new fetch). Zero-alarm sections are filtered (the
  batch-28 zero-bar precedent); when no section has alarms the chart is omitted.
- **L240** — two parts:
  - **Sync**: `_fetch_s3_security` additionally collects `bucket_policy_is_public`
    (GetBucketPolicyStatus, denial-safe: AccessDenied/NoSuchBucketPolicy → None = unknown) —
    the same call/semantics the separate `s3_public_access` fetch already uses, now ON the
    bucket row so the page can chart it. Visible after the next sync-lambda image redeploy +
    sync run (deploy debt).
  - **Page**: new generic `InvType.flagBarKey?: { label, flags: [{ name, col, negate? }] }` —
    INDEPENDENT flag-count bars (a row can count into several bars; this is not a distribution
    of one column, so `countBarKey` doesn't fit). A flag counts rows whose `col` is strictly
    true (strictly false when `negate`) with `'true'`/`'false'` string coercion — null/absent
    (unknown) rows count into NEITHER side (tri-state honesty: an unknown bucket is neither
    Private nor Public). Bars keep the declared order (`preserveOrder`) and zero bars are
    kept — v1 renders all four, and a zero Public bar is itself the signal. `s3` sets
    `flagBarKey: Security Status — Private (bucket_policy_is_public negate) / Public /
    Versioned (versioning_enabled) / Logging (logging_enabled)`; `bucket_policy_is_public`
    joins the detail Security section and the facet keys.
- **L251** — `subnet` sets `countBarKey: { col: 'vpc_id', label: 'Subnets per VPC' }` (the
  batch-27 generic option) — v1's per-VPC pie becomes a count bar, the established v2 idiom
  for count comparisons (the elasticache node-type precedent); labels are full vpc_ids
  (HBarList truncates with a hover title), not v1's 8-char suffixes.

## Testing
- `countFlags` (new pure helper in `web/lib/inventory-derived.ts`): true/false/string
  coercion, negate, unknown-excluded-from-both, declared order kept, zero bars kept.
- Sync: `_fetch_s3_security` rows carry `bucket_policy_is_public` (True/False/None on denial).
- Compliance page: alarms bar renders alarm-count bars with zero sections filtered; absent
  when no alarms.
- Registry invariants keep passing (flagBarKey cols validated like barKey/countBarKey if the
  invariant suite checks those).
- Full `npm test` + `tsc` + build + `pytest scripts/v2/steampipe`; gap-audit ticks with a
  batch-29 note; CHANGELOG EN/KO.
