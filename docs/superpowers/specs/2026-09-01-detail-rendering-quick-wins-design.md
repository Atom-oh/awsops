# Detail-panel rendering quick wins: EBS flags/verdicts + ECS settings — 3 gap-audit items (L209, L210, L215)

**Status:** Batch 23, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch23`.
**WA pillar:** Security / Cost Optimization (risk and waste visibility in the detail panel).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L209 (EBS attachment
DeleteOnTermination flag), L210 (EBS encryption/idle call-outs), L215 (ECS settings readable
rendering).

## Decisions
- **L209** — `structuredList`'s `attachments` branch surfaces `DeleteOnTermination` as the
  row's flag when TRUE (the `block_device_mappings` precedent — the flag styling is the
  warning-tinted text v1 used; true = the volume dies with the instance, the risky case worth
  flagging). False/absent renders no flag — never a fabricated "No".
- **L210** — new `EbsVerdictBanners` block mounted by DetailPanel for `ebs_volume` rows (pure
  client render from the row, no fetch):
  - Encryption verdict: encrypted → green-bordered banner (with the KMS key when available); explicitly
    UNencrypted → red-bordered banner with v1's "consider creating an encrypted copy"
    recommendation; unknown (field absent) → NO banner (tri-state honesty, the EBS-snapshot
    precedent).
  - Idle hint: `state === 'available'` (detached) → amber "idle volume — consider deleting to
    save costs" banner; attached/unknown → nothing.
- **L215** — `structuredList` gains a `settings` branch: ECS cluster `[{Name, Value}]` renders
  as one label–value row per setting (containerInsights disabled — adjacent spans, no glyph) instead of a raw JSON
  code block. Rows with a non-string Name fall back to the JSON rendering (never a half-parsed
  list).

Read-only; no sync/Terraform/schema changes. 4-language i18n for the new banner strings.

## Testing
- structuredList: attachments flag true/false/absent; settings rows + malformed fallback.
- EbsVerdictBanners: encrypted/unencrypted/unknown tri-state; idle vs in-use vs unknown state.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-23 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **The docs-site EBS guide (4 locales) documents the shipped panel (the gate MAJOR)** —
  detail-panel and Attached-Resources sections now list the encryption verdict banner, the
  idle hint, and the per-attachment DeleteOnTermination flag; the idle tip mentions the
  detail banner beside the KPI card; the ECS guides note the label–value Settings rows.
- Settings fall back WHOLE to JSON on a structured Value (no '[object Object]' cell); the
  attachments flag tolerates a text-shaped 'true' (shared truthiness with the banners); the
  banners mount ABOVE the field groups; the idle banner is snapshot-qualified ('마지막 sync
  시점에 미연결' with its own singular term) since the panel carries no freshness stamp;
  component counts bumped 102 → 103 in all five declaration sites.

## Round-2 corrections (review-driven)

- **The EN/JA/ZH guides now carry ALL the round-1 hunks (the gate MAJOR)** — round 1 shipped
  the Attached-Resources DeleteOnTermination bullet and the idle-tip rewrite only in Korean
  while this spec claimed 4 locales; the two hunks are ported and the claim is now true.
- Settings require {string, string} — a null/absent Value also falls back whole to JSON (a
  bare label row is indistinguishable from an empty value); the attachments flag tolerates the
  camelCase `deleteOnTermination` variant (the EbsRelatedSection precedent); idlist copy
  includes the flag (a copied attachments list must not drop DeleteOnTermination/BLACKHOLE);
  the '·' glyph is dropped from the docs (the renderer emits adjacent spans).
