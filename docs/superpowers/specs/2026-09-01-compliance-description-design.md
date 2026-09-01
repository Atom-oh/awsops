# Compliance control description — 1 gap-audit item (L70)

**Status:** Batch 19, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch19`.
**WA pillar:** Security (compliance finding comprehensibility).

Closes gap-audit item (docs/v1-gap-audit-2026-07-19.md): L70 (the control detail slide-over
shows the control's description — the recommendation rationale — alongside
Status/Reason/Resource; v2 collected neither the field nor had a column for it).

## Decisions
- **Migration** `01M1E9JZKCMXT1CW152R6QQQXD_compliance_results_description.sql`:
  `ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''` — backfill-free (existing
  rows read '' → the panel renders '—'; new runs populate it). The same migration re-projects
  the agent's fixed-column `sql_reader.compliance_results` view (01KYVY9J precedent) so the
  reader role sees the new column — idempotent, skipped when the role/schema was never
  provisioned.
- **Worker** (`scripts/v2/workers/compliance.py`): `_walk_controls` collects
  `control.description` (Powerpipe carries it per control; '' when absent) onto every leaf
  result row; `persist` inserts it.
- **Route** (`GET /api/compliance/runs/[id]`): the results SELECT adds `description`.
- **UI** (`web/app/compliance/page.tsx`): the `Result` type gains `description?` — the
  existing DetailPanel flat rendering surfaces it with no further UI change.
- Rows from runs executed BEFORE the worker image redeploy keep '' (honest '—'), same as
  pre-migration rows — no fabricated rationale.

## Testing
- Worker: description rides every leaf result row (fixture updated); absent description → ''.
- Route: the results SELECT carries the description column.
- Full `npm test` + `tsc` + build + pytest; gap-audit tick with a batch-19 note; CHANGELOG EN/KO.

## Deploy note
`make migrate` (the new column + view refresh) must run before the next compliance run is
useful, and the worker image needs a redeploy (`make workers`) for new runs to populate the
field — both are the standard deploy path; no Terraform/IAM changes.
