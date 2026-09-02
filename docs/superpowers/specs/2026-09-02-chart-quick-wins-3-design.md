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
- **L240** — two parts (as amended by rounds 1–2; the original cut's `NoSuchBucketPolicy →
  None`, plain Private/Public labels, and "image redeploy" wording were all reversed):
  - **Sync**: `_fetch_s3_security` additionally collects `bucket_policy_is_public`
    (GetBucketPolicyStatus, denial-safe). **`NoSuchBucketPolicy` — no bucket policy at all,
    the majority case — is a DEFINITIVE "not public via policy" → False**; AccessDenied/other
    → None (unknown). `_fetch_s3_public_access`'s identical call is aligned to the same
    semantics in this PR (the same column on the same bucket must never mean two different
    things across `/inventory/s3` and `/inventory/s3_public_access`). Visible after a
    terraform apply (the sync Lambda is a ZIP via `source_code_hash`, not an image) + a sync
    run (deploy debt).
  - **Page**: new generic `InvType.flagBarKey?: { label, flags: [{ name, col, negate? }] }` —
    INDEPENDENT flag-count bars (a row can count into several bars; this is not a distribution
    of one column, so `countBarKey` doesn't fit). A flag counts rows whose `col` is strictly
    true (strictly false when `negate`) with `'true'`/`'false'` string coercion — null/absent
    (unknown) rows count into NEITHER side, and a column with NO known value on any row drops
    its flags entirely (an all-unknown 0/0 must not render as an all-clear). Bars keep the
    declared order (`preserveOrder`); zero bars on a known column are kept (a real zero is
    signal). `s3` sets `flagBarKey: Security Status — **Policy Private / Policy Public**
    (policy-only measure — deliberately NOT plain Private/Public, which would false-all-clear
    a BPA-disabled bucket that `PUBLIC_S3_WHERE` flags on /security) / Versioned
    (versioning_enabled) / Logging (logging_enabled)`; `bucket_policy_is_public` joins the
    detail Security section and the facet keys (FACET_LABELS 'Policy Public').
- **L251** — `subnet` sets `countBarKey: { col: 'vpc_id', label: 'Subnets per VPC' }` (the
  batch-27 generic option) — v1's per-VPC pie becomes a count bar, the established v2 idiom
  for count comparisons (the elasticache node-type precedent); labels are full vpc_ids
  (HBarList truncates with a hover title), not v1's 8-char suffixes.

## Testing
- `countFlags` (new pure helper in `web/lib/inventory-derived.ts`): true/false/string
  coercion, negate, unknown-excluded-from-both, all-unknown column drops its flags, declared
  order + real-zero bars kept once a column has any known value.
- Sync: BOTH fetchers' rows carry `bucket_policy_is_public` (True / False incl. no-policy /
  None on denial — lockstep asserted on each side).
- Compliance page: alarms bar renders alarm-count bars with zero sections filtered; absent
  when no alarms.
- Registry invariants keep passing (flagBarKey cols validated like barKey/countBarKey if the
  invariant suite checks those).
- Full `npm test` + `tsc` + build + `pytest scripts/v2/steampipe`; gap-audit ticks with a
  batch-29 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **NoSuchBucketPolicy is a DEFINITIVE "not public via policy" → False (the gate MAJOR)** —
  the first cut lumped it with AccessDenied as None, which would have zeroed BOTH Policy bars
  on a typical fleet (most buckets have no bucket policy at all), contradicting this spec's
  own claim. Follows the `NoSuchPublicAccessBlock → False` precedent 30 lines above in the
  same file; the sync test now pins nopolicy → False.
- **The bars are labeled Policy Private / Policy Public (the gate MAJOR)** — the flag
  measures bucket-policy status only, narrower than `PUBLIC_S3_WHERE`'s full exposure
  predicate (policy OR BPA-disabled); a plain 'Private' would false-all-clear a BPA-disabled
  bucket that /security simultaneously flags HIGH. Guides/CHANGELOG renamed to match (the
  s3_public_access 'Policy public' labeling precedent).
- HBarList's 2% visibility floor now applies only to NONZERO values — a kept zero bar must
  render visually empty; `bucket_policy_is_public` gains a FACET_LABELS entry ('Policy
  Public'); countBar/flagBar titles get the hist-precedent `(표본 기준)` suffix when the
  500-row fetch is truncated; Alarms by Section is capped top-10 by count (the countBarKey
  precedent) and its title carries a '· per finding' hint (the bars count leaf results — one
  per checked resource — while the adjacent donut counts controls).
- Wording: the sync deploy is a **terraform apply (ZIP `source_code_hash`)**, not an image
  redeploy; the ticked audit line carries an inline 2026-09-02 correction per the file's
  correction precedent.

## Round-2 corrections (review-driven)

- **`_fetch_s3_public_access` aligned to `NoSuchBucketPolicy → False` (the gate MAJOR)** —
  round 1 fixed only the NEW fetch, leaving the same-named column with two semantics on the
  same bucket across two live inventory types (contradictory Private/unknown counts between
  `/inventory/s3` and `/inventory/s3_public_access`). Both handlers + docstrings now state the
  lockstep requirement; a new test pins the s3_public_access side. `PUBLIC_S3_WHERE`
  (`= 'true'`) is unaffected.
- **§Decisions amended IN PLACE (the L5 MAJOR)** — the Decisions section no longer asserts the
  reversed round-1 choices ("→ None", plain Private/Public, "image redeploy") nor the false
  "same call/semantics" claim (now true again after the alignment).
- All-unknown columns drop their flags entirely (`countFlags`) so the pre-first-sync window
  renders no Policy bars instead of a fabricated "Policy Private 0 / Policy Public 0"
  all-clear; the Alarms by Section card labels truncation ("Top 10 of N · per finding");
  the misleading "precedent above" comment names `_fetch_s3_public_access` explicitly;
  compliance docs (4 locales) state the per-finding basis; s3 docs mention the new facet;
  the CHANGELOG bullet is prefixed "(compliance/S3/subnets)" to distinguish it from the
  batch-27 "Chart quick wins" bullet.
