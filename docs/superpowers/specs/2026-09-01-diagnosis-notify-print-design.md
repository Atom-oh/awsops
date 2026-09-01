# Diagnosis notification pause toggle + printable report view — 2 gap-audit items (L178, L179)

**Status:** Batch 21, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch21`.
**WA pillar:** Operational Excellence (notification control without a deploy / report sharing).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L178 (email-notification on/off UI
toggle), L179 (browser print-to-PDF report view).

## Decisions

### L178 — notification pause toggle
- **Storage**: new generic `app_settings` table (key/value/updated_at) via migration
  `..._app_settings.sql` — the repo had no key-value settings store; this is deliberately
  minimal and reusable. Key `diagnosis_notify_paused` ('true'/'false'; ABSENT = not paused,
  preserving today's behavior with zero backfill).
- **Route** `GET/PUT /api/diagnosis/notify` — GET returns `{paused, canManage}` for any
  authenticated user; PUT is admin-only (`isAdmin`, the subscribers-route precedent) and
  upserts the flag. PAUSE ≠ ADR-005 territory: it writes one Aurora row, no AWS mutation.
- **Worker** (`diagnosis_digest.lambda_handler`): reads the flag before publishing; when
  paused, SKIPS the SNS publish but STILL stamps `notified_at` — exactly the existing
  no-topic behavior (reports completed while paused are dropped from email, not queued for a
  stale blast on re-enable; documented). A flag-read failure fails OPEN (publish) — a broken
  settings read must not silently kill notifications.
- **UI** (`SubscribersPanel`): a pause switch at the top of the panel (visible whenever the
  feature is enabled; interactive for admins, read-only state otherwise) + a paused badge.
  v1's bell/badge is folded into the existing panel rather than a separate header button.

### L179 — printable report view
- New page `/ai-diagnosis/report?id=N` (client): fetches the existing
  `GET /api/diagnosis/[id]` (owner-or-admin enforced server-side), renders a white-background
  A4 print layout — cover block (title/tier/created/finished), numbered TOC anchored to the
  report's `## ` sections, one `<section>` per heading with `break-before: page` print CSS,
  and Print (window.print) / Close (window.close, history fallback) buttons hidden in print
  media. Splitting on `## ` headings only (the worker's section contract); reuses
  `ReportMarkdown` per section. The DiagnosisView report list gains a '인쇄용 보기' link
  opening the page in a new tab (v1 parity).
- The server PDF download remains the primary export; this is the v1 preview/print path.

No Terraform/IAM changes; one additive migration.

## Testing
- Route: GET shape, PUT admin-gate + validation, upsert SQL.
- Worker: paused → no publish + stamped; absent flag → publish; flag-read error → publish
  (fail-open).
- Print page: cover/TOC/sections render from markdown; missing id / fetch error states;
  Print/Close buttons present (screen) — print CSS asserted by class.
- Panel: switch renders for admins, read-only for non-admins, reflects paused state.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-21 note; CHANGELOG EN/KO.
