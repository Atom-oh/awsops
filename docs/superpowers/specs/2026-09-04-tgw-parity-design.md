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
     (`DescribeTransitGatewayVpcAttachmentsCommand`, one call per region, read-only) and
     merges `options` (DnsSupport/Ipv6Support/ApplianceModeSupport) into the attachment rows;
     the attachments table gains a compact Options column.
- **Disclosed deviations** (recorded in the audit tick):
  - v1's TGW *tab on the vpc page* is a dedicated `/inventory/transit_gateway` page in v2
    (the established structural deviation — same as the L253 waf precedent; the vpc menu
    group links it).
  - v1's row-click options JSON becomes an inline Options column; options exist only for VPC
    attachments (the API exposes them per-type) — other attachment types read '—'.
  - Routes remain active/blackhole-only with a per-table cap (pre-existing, already disclosed
    in the UI).

## Testing
- NEW web/lib/tgw.test.ts (the layer had no tests): region-grouped fan-out, VPC-attachment
  options merge (non-VPC rows keep options null), degraded-region honesty, route truncation
  flag, cache reset seam.
- pytest scripts/v2/steampipe: the transit_gateway SELECT remains registered/read-only.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; audit tick +
  batch-42 note; CHANGELOG EN/KO; docs-site network guide touch only if it names TGW columns.
