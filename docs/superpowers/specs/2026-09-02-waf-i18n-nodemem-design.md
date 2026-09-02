# WAF rule groups/IP sets, /eks/cost i18n, node memory KPI — 3 gap-audit items (L253, L219, L234)

**Status:** Batch 32, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch32`.
**WA pillar:** Security / Operational Excellence.

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L253 (WAF Rule Groups / IP Sets),
L219 (eks-container-cost page i18n), L234 (K8s node memory Capacity/Allocatable/Reserved).

## Decisions
- **L253** — two new synced inventory types, columns verified against the PINNED plugin
  source (`v0.142.0/aws/table_aws_wafv2_{rule_group,ip_set}.go` — both tables exist; List
  needs no quals; the id/name/scope key quals apply to Get only):
  - `waf_rule_group`: name/region/account_id/id/arn/scope/capacity/description/rules/
    visibility_config/tags — spec in the Security group (scope donut, WCU capacity bar — the
    `waf` type's shape), HIGHLIGHTS (total, WCU sum).
  - `waf_ip_set`: name/…/scope/ip_address_version/addresses/tags — spec with an
    `addresses_count` derived column (len of the addresses array; undefined when the field is
    absent — never a fabricated 0), IPv4/IPv6 facet, HIGHLIGHTS (total, per-version counts).
  - v1's three KPI tiles on ONE waf page (Web ACLs / Rule Groups / IP Sets) map to v2's
    idiom: the Security group overview (`/inventory/g/security`) renders per-type count
    tiles once the two types join its order list, and each type page carries its own KPI
    band — a deliberate structural deviation, disclosed in the audit note. Visible after the
    sync-lambda terraform apply + a sync run (existing deploy debt; ORDER BY name, read-only
    SELECTs, no new IAM — wafv2 List/Get is already granted to the Steampipe/aggregator
    path like the existing `waf` type).
- **L219** — the `/eks/cost` page body's remaining hardcoded Korean literals go through
  `tt()` (title/subtitle already auto-translate via PageHeader/Card/StatTile — the gap is
  inline JSX text: load-fail/loading lines, the estimate-fallback banner, the two
  empty-state sentences, the search placeholder) and every literal is REGISTERED in TERMS
  4-language (tt passthrough hides missing registrations — most tile/card labels were
  already registered; the missing ones are added). The banner's inline `<b>` is dropped in
  favor of one translatable sentence (word order differs across languages; a 3-fragment
  split would not translate).
- **L234** — the remaining half (per-node CPU/Memory Requested/Available/Reserved stack
  bars, the node-drilldown 3-split cards, and the fleet total-capacity tiles already ship):
  the nodes fleet page's 총 Memory (GiB) KPI tile gains v1's allocatable/reserved analysis
  as its hint — `allocatable N GiB · reserved M%` (Reserved = Capacity − Allocatable) —
  shown only when allocatable is actually reported (>0 sum; an unreported fleet must not
  read 'reserved 100%').

## Testing
- Sync: both QUERIES registered with verified columns + id/region cols.
- waf_ip_set deriver: addresses_count len/absent-undefined.
- Registry invariants keep passing (new specs validated like every type).
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; gap-audit ticks
  with a batch-32 note; CHANGELOG EN/KO; docs-site guides in 4 locales.

## Round-1 corrections (review-driven)

- **L219 actually finished (the gate MAJOR)** — the page still rendered untranslated Korean
  in three places the first pass missed: the no-cluster empty state (a Card CHILD — Card
  translates only its title/subtitle props) and the three per-cluster source chips (Badge
  has no useI18n). All now go through `tt()` with the missing TERMS keys registered
  (미가용/OpenCost 실측/the empty-state sentence; 요청 기반 추정 was already registered).
- The reserved% hint requires EVERY capacity-bearing node to report allocatable (a partial
  fleet inflated reserved% — missing allocatable counted 0 in the numerator but full
  capacity in the denominator). The hint's `allocatable N GiB · reserved M%` phrasing stays
  English shorthand, matching the NodeCapacityList caption precedent ('avail X | rsv Y').
- Noted, non-gating: keying the new WAF types by `arn` instead of `name` is a possible
  follow-up hardening (the chair verified no collision exists — CLOUDFRONT keys under
  region 'global'); whether the WAF family should join ADMIN_ONLY_TYPES deserves a
  deliberate owner decision (the existing `waf` type already exposes rules ungated).
