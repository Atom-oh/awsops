# Transit Gateway parity completion — 1 gap-audit item (L168)

**Status:** Batch 42, 2026-09-04 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch42`.
**WA pillar:** Operational Excellence (TGW config/option visibility at v1 parity).

Closes gap-audit item (docs/v1-gap-audit-2026-07-19.md): L168 (v1's vpc-page TGW tab: TGW
list with ASN/DNS/state, attachments table with row-click options detail, per-TGW route
tables with routes).

## Decisions

- **The audit's blocker text is STALE — most of L168 already shipped in earlier batches**:
  the `transit_gateway` inventory type is synced (state/ASN/description/…); the dedicated
  /inventory/transit_gateway page renders TgwSection — CloudWatch diagnostics
  (Bytes/Packets + Blackhole/NoRoute drop danger flags, beyond v1), the attachments table
  (TGW/Attachment/Type/Resource/State/Route Table with non-available danger), and per-TGW
  route tables with routes (CIDR/Type/State/Target, active+blackhole only, per-table cap —
  both disclosed in the card subtitle). What this batch adds is the RESIDUE vs v1:
  1. **TGW option columns are not synced** — v1's list showed ASN/DNS. The sync SELECT gains
     the option columns (`dns_support`, `vpn_ecmp_support`, `multicast_support`,
     `auto_accept_shared_attachments`, `default_route_table_association`,
     `default_route_table_propagation`, `association_default_route_table_id`,
     `propagation_default_route_table_id` — all standard `aws_ec2_transit_gateway` columns in
     the pinned plugin), the spec's list gains ASN + DNS columns, and the Config detail
     section gains the option keys. New columns populate after the sync-lambda redeploy +
     next sync (the batch-29 bucket_policy precedent — until then they read blank, never 0).
  2. **Attachment options are invisible** — v1 showed a row-click options JSON. lib/tgw.ts
     additionally describes VPC attachments per region
     (`DescribeTransitGatewayVpcAttachmentsCommand`, read-only, NextToken-paginated ≤5 pages
     — amended in rounds 1–2: originally written as one call) and merges `options`
     (DnsSupport/Ipv6Support/ApplianceModeSupport) into the attachment rows; the attachments
     table gains a compact Options column, every incomplete-view path discloses via
     `optionsDegradedRegions`, and the web task role gains the single read-only IAM action
     (see Round-1/2 sections).
- **Disclosed deviations** (recorded in the audit tick):
  - v1's TGW *tab on the vpc page* is a dedicated `/inventory/transit_gateway` page in v2
    (the established structural deviation — same as the L253 waf precedent; the vpc menu
    group links it).
  - v1's row-click options JSON becomes an inline Options column; options exist only for VPC
    attachments (the API exposes them per-type) — other attachment types read '—'.
  - Routes remain active/blackhole-only with a per-table cap (pre-existing, already disclosed
    in the UI).

## Testing (amended to as-shipped after rounds 1–2)
- NEW web/lib/tgw.test.ts (the layer had no tests): region-grouped fan-out, VPC-attachment
  options merge (non-VPC rows keep options null), degraded-region honesty, route truncation
  flag, options pagination (NextToken follow + page-cap leftover disclosure + page-N failure
  keeping fetched pages), RAM-shared reconciliation disclosure, and the IAM wiring guard
  (module-source-derived command list ↔ workload.tf grants).
- pytest scripts/v2/steampipe: the transit_gateway SELECT remains registered/read-only.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; audit tick +
  batch-42 note; CHANGELOG EN/KO; docs-site network guide touch only if it names TGW columns.

## Round-1 corrections (review-driven)

- **The IAM grant ships in this PR (the gate MAJOR)** — the web task role's EC2 actions are an
  explicit enumeration lacking `ec2:DescribeTransitGatewayVpcAttachments`, so every options
  describe would AccessDenied, the catch would swallow it, and the 4-minute TTL would memoize
  the empty result: the headline column permanently '—' in production while the docs claimed
  it delivered. workload.tf gains the single read-only action next to its three TGW siblings
  (least-privilege preserved); requires `terraform apply` (deploy debt). A new test pins every
  TGW SDK command this module issues to its workload.tf grant (closing the "new SDK call,
  forgotten IAM action" class for this layer).
- **Options denial is disclosed, never conflated with "not a VPC attachment" (the gate
  MAJOR)** — the silent `.catch(→[])` violated this file's own honest-degrade contract
  (degradedRegions = "MISSING, not empty"). The options describe now returns null on failure
  (≠ empty list), surfaces `optionsDegradedRegions` through /api/tgw, and the card subtitle
  names the degraded regions; the test that pinned the silent behavior now pins the
  disclosure.
- Minors closed: the VPC-attachment describe follows NextToken (≤5 pages — the general
  attachment list's cap is pre-existing, but the asymmetry would have made a DISPLAYED row
  past page 1 read '—' silently); missing individual option fields render '—' per the table's
  null convention (was '?'); the CHANGELOG's blank-until-next-sync caveat is scoped to the
  DNS/option columns (ASN was already synced and shows immediately, EN/KO amended in place);
  the audit tick's retained original sentence gains a "(감사 당시 서술)" qualifier;
  web/lib/CLAUDE.md's tgw.ts trap line records the third describe + the options-degrade
  contract + the IAM-wiring guard; api-reference names optionsDegradedRegions.
- Recorded (accepted/noted): the pre-redeploy dns_support facet offers only '(none)' until
  the sync lambda redeploys (CHANGELOG-disclosed transitional state); RAM-shared cross-account
  VPC attachments may not return options via the per-type describe — if observed, they land
  under the same disclosed-null path, not a fabricated value.

## Round-2 corrections (review-driven)

- **The pagination cap can no longer report a truncated view as success (the gate MAJOR)** —
  the round-1 5-page loop exited with a leftover NextToken and `optionsDegraded=false`,
  recreating exactly the silent '—' conflation this PR forbids (and contradicting the
  CHANGELOG's "follows pagination" claim). A leftover token now marks the region's options
  incomplete; test pins 5 pages + disclosure.
- Minors closed: a page-N failure KEEPS the already-fetched pages while still disclosing the
  region (a throttle on page 3 no longer blanks pages 1–2 into the 4-minute TTL); a VPC-type
  row the successful options response never returned (the RAM-shared cross-account caveat) is
  reconciled into the same disclosure — the spec's earlier "lands under the disclosed-null
  path" claim is now actually true; the TgwSection catch clears the stale degraded-region
  list; the catch logs the error NAME server-side (AccessDenied vs Throttling matters in the
  merge→apply window; never the raw message); the IAM wiring guard derives the command list
  from tgw.ts's own source (a 5th SDK command without a grant turns it red) and matches
  quoted action entries rather than any substring; the subtitle wording covers all three
  incomplete causes ('조회 실패·절단·미반환').
- Recorded (accepted, out of scope): region-level disclosure is not row-attributable (no
  region column on the attachments table — the subtitle bounds the ambiguity); member-account
  TGWs under-report through this whole layer (pre-existing host-credential pattern across
  TgwSection, not an options-specific defect — follow-up issue candidate).
