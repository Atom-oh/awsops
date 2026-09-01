# Detail/column quick wins 2: IAM description, Lambda size/layers/VPC, WAF action — 4 gap-audit items (L224, L231, L232, L252)

**Status:** Batch 26, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch26`.
**WA pillar:** Operational Excellence (scanability / readable detail).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L224 (IAM role Description column),
L231 (Lambda Code Size column), L232 (Lambda readable layers + 'Not in VPC'), L252 (WAF
Default Action readable).

## Decisions
- **L224** — `iam_role` spec gains `{ key: 'description', label: 'Description' }` (already
  synced and already in the detail Identity section; absent renders the table's blank cell).
- **L231** — `lambda` deriver gains `code_size_h` via the existing `bytesH` helper (B/KB/MB);
  added as a table column and replacing the raw `code_size` in the detail Capacity section
  (raw hidden via `hideKeys` — the derived value is the same number, readable).
- **L232** — `lambda` deriver gains `layers_h`: parses the layers JSON into a raw string
  ARRAY (one `name:version` per row via idlist rendering — the trailing two ARN segments),
  `undefined` when absent; and `vpc_h`: the vpc_id when present, '**Not in VPC**' when the
  synced field is explicitly null/empty (v1's explicit empty state; absent field entirely →
  undefined). Detail sections updated (Capacity uses layers_h; a Network section shows vpc_h,
  vpc_subnet_ids, vpc_security_group_ids).
- **L252** — `waf` deriver gains `default_action_h`: the action KEY from the default_action
  JSONB ('Allow'/'Block' — the object's own top-level key, case-preserved), placed before the
  raw blob in the Security section (raw stays visible — info availability).

Read-only; no sync/Terraform/schema changes. Table labels are English (existing convention).

## Testing
- Derivers: code_size_h formats; layers_h array/one-per-row parse + absent; vpc_h tri-state
  (id / Not in VPC / undefined); default_action_h Allow/Block/malformed-undefined.
- Registry invariants keep passing.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-26 note; CHANGELOG EN/KO.
