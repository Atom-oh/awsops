# S3 tags, EKS pod detail columns, EKS no-access banner — 3 gap-audit items (L243, L226, L227)

**Status:** Batch 31, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch31`.
**WA pillar:** Operational Excellence (drill-down completeness / onboarding legibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L243 (S3 detail Tags section),
L226 (node-drilldown pods table Pod IP / Service Account columns), L227 (EKS page-level
no-access banner with error detail + docs link).

## Decisions
- **L243** — `_fetch_s3_security` additionally collects bucket tags via per-bucket
  `GetBucketTagging` (denial-safe, the batch-29 policy-status pattern): `NoSuchTagSet` is a
  DEFINITIVE "no tags" → `{}` (v1 renders 'No tags'); AccessDenied/other → key absent =
  unknown (the detail panel simply shows nothing rather than a fabricated empty list). The
  TagSet list is folded to a `{Key: Value}` dict (the Steampipe-jsonb shape DetailPanel's
  existing `tags` renderer already handles). `s3` spec gains a Tags section. Visible after
  the sync terraform apply + a sync run (existing deploy debt).
- **L226** — the remaining half of the item (the Pod Info card already shows Pod CIDR +
  Created): `PodRow` gains `serviceAccount` (`spec.serviceAccountName`, '' when absent) and
  the node-drilldown pods table gains **Pod IP** and **Service Account** columns ('-' when
  unknown — a terminated pod has no IP).
- **L227** — `/eks` gains a page-level no-access banner rendered when the cluster list
  loaded non-empty but ZERO clusters are connected, or every connected cluster's live fleet
  read failed: title + description (Access Entry / 등록 안내), the raw per-cluster error in
  a mono box (the fleet route now carries a truncated `error` string on unreachable entries
  instead of swallowing it — v1 showed the raw Steampipe error), and a link to the docs-site
  EKS auth guide (`NEXT_PUBLIC_DOCS_URL` env override, defaulting to the published docs URL;
  the guide page `compute/eks-auth` exists in all 4 locales). The banner never renders while
  loading or when at least one cluster serves data.

## Drive-by hardenings (PR #275 round-3 review MINORs, one-liners)
- The compliance notify dedup claim adds `AND notified_at IS NULL` on the target row —
  defense-in-depth against a manual SFN re-drive of an already-notified run re-claiming its
  own window.
- The dashboard cost-impact list hides when the two trend endpoints snapshot DIFFERENT type
  sets (the `netChange` strict type-set-parity precedent) — a mid-fan-out latest day must
  not transiently render an incomplete top-8.

## Testing
- Sync: tags fold to a dict; NoSuchTagSet → {}; denial → absent key.
- normalizePod: serviceAccount mapped, '' when absent; NodePodsSection renders the two new
  columns with '-' fallbacks.
- Fleet route: an unreachable cluster entry carries the truncated error string.
- notify claim: a run whose own notified_at is already set cannot re-claim.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; gap-audit ticks
  with a batch-31 note; CHANGELOG EN/KO; docs-site guides in 4 locales.
