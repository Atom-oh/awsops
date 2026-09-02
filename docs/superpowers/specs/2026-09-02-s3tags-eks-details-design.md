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
  the sync terraform apply + a sync run (existing deploy debt). The inv-sync role's
  ENUMERATED S3 action list gains `s3:GetBucketTagging` (a read-only Get, same class as the
  batch-29 `GetBucketPolicyStatus` — without it every bucket's tag read is denied and the
  feature is dead-on-arrival; caught by self-check against `steampipe.tf`).
- **L226** — the remaining half of the item (the Pod Info card already shows Pod CIDR +
  Created): `PodRow` gains `serviceAccount` (`spec.serviceAccountName`, '' when absent) and
  the node-drilldown pods table gains **Pod IP** and **Service Account** columns ('-' when
  unknown — a terminated pod has no IP).
- **L227** (as amended by round 1) — `/eks` gains a page-level no-access banner rendered
  when the fleet loaded non-empty and EVERY fleet cluster is unreachable (registered clusters
  exist but zero live K8s data — unregistered clusters keep their existing per-cluster
  onboarding guides instead): title + description (Access Entry / 등록 안내), the raw
  per-cluster error in a mono box (the fleet route now carries a truncated `error` string on
  unreachable entries instead of swallowing it — v1 showed the raw Steampipe error; the
  eksToken() no-secret-in-message invariant is documented at the catch site), and a
  LOCALE-AWARE link to the docs-site **`compute/eks` v2-current overview guide** (NOT the
  archived v1 `eks-auth` page — round-1 gate; the URL is a build-time constant, not an env:
  `NEXT_PUBLIC_*` inlines at build and the Dockerfile passes no such ARG). The banner never
  renders while the fleet is still loading (fleetLoaded is set by both the initial load and
  manual refresh) or when any cluster serves data.

## Drive-by hardenings (PR #275 round-3 review MINORs, one-liners)
- The compliance notify dedup claim adds `AND notified_at IS NULL` on the target row —
  defense-in-depth against a manual SFN re-drive of an already-notified run re-claiming its
  own window.
- The dashboard cost-impact list hides when the LATEST day is missing a WEIGHTED type the
  baseline has (a partial sync fan-out; as amended by round 1 — an all-type equality check
  self-disabled the panel on any new or transiently-failed type).

## Testing
- Sync: tags fold to a dict; NoSuchTagSet → {}; denial → absent key.
- normalizePod: serviceAccount mapped, '' when absent; NodePodsSection renders the two new
  columns with '-' fallbacks.
- Fleet route: an unreachable cluster entry carries the truncated error string.
- notify claim: a run whose own notified_at is already set cannot re-claim.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; gap-audit ticks
  with a batch-31 note; CHANGELOG EN/KO; docs-site guides in 4 locales.

## Round-1 corrections (review-driven)

- **The banner links the v2-current `compute/eks` guide, not the archived v1 `eks-auth` page
  (the L5 MAJOR, 3/3 models)** — eks-auth's own caution says "do not apply to v2"; the
  banner note moved into eks.md (4 locales), the eks-auth :::info additions were reverted,
  and the href is locale-aware (`/{lang}` for non-ko).
- **The cost-impact parity gate is a weighted-subset check, not all-type equality (the L4
  MAJOR)** — equality self-disabled the panel for ~30 days on any new/failed type, including
  unweighted ones the estimator ignores; now it hides only when the LATEST day is missing a
  weighted type the baseline has. The batch-30 CHANGELOG bullet's hide-condition enumeration
  was amended in place.
- Minors: `fleetLoaded` is also set by manual refresh (a failed initial load no longer
  suppresses the banner for the session); skip-class notify outcomes never overwrite an
  existing emailed/publish_failed record (`only_if_blank`, ADR-013 sentence added); the
  unwireable `NEXT_PUBLIC_DOCS_URL` claim removed (constant + comment); tags empty-state
  wording aligned to the actual '—' rendering and the deploy precondition spelled out
  (terraform apply + sync) in CHANGELOG/docs; fleet error-string invariant comment added.

## Round-2 corrections (review-driven)

- **ALL three skip-class outcomes are blank-guarded (the gate MAJOR)** — round 1 guarded only
  `skipped_dedup`; `skipped_no_topic` and `dropped_paused` run EARLIER in the flow and could
  still overwrite a durable emailed/publish_failed record on a manual SFN re-drive,
  contradicting the ADR-013 sentence added in round 1. Both call sites now pass
  `only_if_blank=True`; a test walks all three branches and asserts the `notify_outcome=''`
  guard on each.
- Noted as follow-ups (chair MINORs, not gated): the banner reflects the page's pre-existing
  unscoped fleet next to account-scoped rows; the raw K8s error mono box could be
  admin-gated or code-mapped; `s3:GetBucketTagging` shares the statement's pre-existing
  `Resource = "*"` shape.

## Round-3 corrections (review-driven)

- **The eks.md registration docs describe the REAL v2 flow (the gate MAJOR)** — the guide
  (all 4 locales) claimed a nonexistent "Register ViewPolicy 자동 등록" button; the actual
  flow never creates an Access Entry at runtime (ADR-005): Access Entry lookup-register
  (409 + onboarding script when absent) / SA token / AssumeRole, plus the Terraform
  onboarding (`make configure` → `eks.tf`). The stats-card `/k8s/*` route refs were fixed
  to `/eks/*` in passing.
- The banner's mono box now shows up to two `cluster: error` pairs (naming the cluster —
  making the CHANGELOG's "per-cluster failure reason" literally true); the spec's Drive-by
  section was aligned to the round-1 weighted-subset gate; ADR-013's Status line gains the
  dated 2026-09-02 amendment entry.
