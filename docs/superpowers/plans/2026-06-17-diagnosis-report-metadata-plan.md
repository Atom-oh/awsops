# Plan — AI Diagnosis report metadata (title/tags/edit/soft-delete)

> Spec: `docs/superpowers/specs/2026-06-17-diagnosis-report-metadata-design.md`.
> Branch base `af76c89` (worktree `feat/diagnosis-report-meta`). TDD: failing test → minimal code →
> refactor; **per-task commit**. Read-only feature (metadata on read-only reports). Owner decisions:
> LLM one-line title + auto-suggest tags, soft delete, owner-or-admin edit/delete.

## Allowed file scope
- `terraform/v2/foundation/migrations/01KVACJV5S0PAGFXTZFMYFQA93_diagnosis_metadata.sql`
- `scripts/v2/workers/diagnosis/report.py`
- `scripts/v2/workers/diagnosis/db.py`
- `scripts/v2/workers/handlers.py`
- `scripts/v2/workers/diagnosis/test_report.py`
- `web/lib/diagnosis.ts`
- `web/lib/diagnosis.test.ts`
- `web/app/api/diagnosis/[id]/route.ts`
- `web/app/api/diagnosis/[id]/route.test.ts`
- `web/app/api/diagnosis/route.ts`
- `web/app/api/diagnosis/route.test.ts`
- `web/components/diagnosis/DiagnosisView.tsx`
- `web/components/diagnosis/DiagnosisView.test.tsx`

## Out of scope
Hard delete / S3 cleanup, tag autocomplete/taxonomy, search, `download/route.ts`, the diagnosis
collectors/sections, deep-tier resolver, scheduling/notifications.

---

## Tasks

### Task 1: Migration — title / tags / deleted_at
- Create: `terraform/v2/foundation/migrations/01KVACJV5S0PAGFXTZFMYFQA93_diagnosis_metadata.sql`
- [ ] Idempotent: `ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS title text, ADD COLUMN IF
      NOT EXISTS tags text[] NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`
      with a header comment (soft-delete orthogonal to status; read-only posture). Do NOT INSERT into
      schema_migrations (the runner stamps it).
- [ ] Commit: `feat(diagnosis): migration — report title/tags/deleted_at`.

### Task 2: web/lib — fields, soft-delete filter, mutators, permission
- Modify: `web/lib/diagnosis.ts`
- Test: `web/lib/diagnosis.test.ts`
- [ ] Failing tests: `listReports` SQL contains `deleted_at IS NULL`; `updateReportMeta(7,{title:'t',
      tags:['a']})` issues an UPDATE binding title+tags; `softDeleteReport(7)` sets `deleted_at = now()`
      `WHERE ... deleted_at IS NULL`; `canMutateReport` → owner true, stranger false (mock `isAdmin`).
- [ ] Implement: `DiagnosisReport` += `title: string|null`, `tags: string[]`, `deleted_at: string|null`;
      `REPORT_COLS` += `title, tags, deleted_at`; `listReports` adds `WHERE deleted_at IS NULL`;
      `updateReportMeta(id, {title?, tags?})` (COALESCE-style partial update), `softDeleteReport(id)`;
      `canMutateReport(user, report)` = `isAdmin(user) || report.requested_by === (user.email ?? user.sub)`
      (import `isAdmin` from `@/lib/admin`).
- [ ] Run `npm --prefix web test -- lib/diagnosis` (green).
- [ ] Commit: `feat(diagnosis): report title/tags/deleted_at + mutators + canMutateReport (lib)`.

### Task 3: Worker — auto title + suggested tags (isolated) + finish_report
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Modify: `scripts/v2/workers/diagnosis/db.py`
- Modify: `scripts/v2/workers/handlers.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Failing tests: `report.make_title_and_tags` parses a fenced-JSON model reply
      (monkeypatch `_bedrock_render` → ```json {"title":"핵심","tags":["보안","비용"]}```) → {title,tags};
      malformed reply → {title:None, tags:[]}. `db.finish_report(..., title=, tags=)` includes them in
      the UPDATE. `_report`: a `make_title_and_tags` exception leaves the report succeeded (isolation).
- [ ] Implement `make_title_and_tags(md)` in report.py: `_bedrock_render(TITLE_PROMPT, md,
      _TITLE_MODEL, 300)` where `_TITLE_MODEL = os.environ.get("DIAGNOSIS_TITLE_MODEL", _MODEL_SONNET)`;
      TITLE_PROMPT asks for a Korean ≤40-char single-key-insight title + 3–5 short tags as JSON;
      strip ```fences and `json.loads`; clamp title length + tags (≤10, ≤40 each); on any error return
      `{"title": None, "tags": []}`.
- [ ] `db.finish_report` gains optional `title=None, tags=None` → adds `title=:t2, tags=:tg` to the SET
      only when provided (keep the `WHERE status='running'` guard).
- [ ] `handlers._report`: after `generate`, `meta = report.make_title_and_tags(md)` wrapped in
      try/except (log + `{title:None,tags:[]}` on failure), pass `title=meta["title"], tags=meta["tags"]`
      to `finish_report`.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/ -q` (green).
- [ ] Commit: `feat(diagnosis): worker auto-title + suggested tags (isolated)`.

### Task 4: BFF `[id]` — PATCH + DELETE + can_edit on GET
- Modify: `web/app/api/diagnosis/[id]/route.ts`
- Test: `web/app/api/diagnosis/[id]/route.test.ts`
- [ ] Failing tests: PATCH `{title,tags}` as owner → 200 + `updateReportMeta` called; as admin → 200;
      as stranger → 403; unauth → 401; missing report → 404; invalid (title > 200 / tags not array /
      tag too long) → 400. DELETE as owner/admin → 200 + `softDeleteReport`; stranger → 403. GET
      response includes `can_edit`.
- [ ] Implement PATCH + DELETE: `verifyUser` (401) → id NaN guard (400) → `getReport` (404) →
      `canMutateReport` (403) → PATCH validates body then `updateReportMeta`; DELETE `softDeleteReport`.
      Extend GET to add `can_edit = await canMutateReport(user, report)` to the JSON.
- [ ] Run `npm --prefix web test -- "[id]/route"` (green).
- [ ] Commit: `feat(diagnosis): BFF report PATCH/DELETE (owner|admin) + can_edit`.

### Task 5: BFF list — per-report can_edit
- Modify: `web/app/api/diagnosis/route.ts`
- Test: `web/app/api/diagnosis/route.test.ts`
- [ ] Failing test: GET `/api/diagnosis` returns reports each carrying `can_edit` (owner/admin true,
      else false) — compute `isAdmin(user)` once, map `requested_by === user`.
- [ ] Implement: in the GET handler, after `listReports`, attach `can_edit` per report (admin OR
      owner). Keep the POST path unchanged.
- [ ] Run `npm --prefix web test -- "diagnosis/route"` (green).
- [ ] Commit: `feat(diagnosis): list route attaches can_edit per report`.

### Task 6: UI — title (list + editable header), tags, delete
- Modify: `web/components/diagnosis/DiagnosisView.tsx`
- Test: `web/components/diagnosis/DiagnosisView.test.tsx`
- [ ] Failing tests: a report with a title shows the title as the list's primary line (null → `#id`
      fallback); when `can_edit`, a delete control appears and (after confirm) POSTs DELETE then
      reloads; the opened header shows an editable title (save → PATCH) + tag chips (add/remove →
      PATCH); when `can_edit` is false, no edit/delete controls render.
- [ ] Implement: list primary = `r.title || '#'+r.id …`; per-row delete (trash, `can_edit`) with a
      confirm; opened header inline title edit + tag chips, gated on `view`/row `can_edit`; PATCH/DELETE
      via `fetch`. Match paper/ink/brand + AA contrast. (`ReportRow`/view types gain title/tags/can_edit.)
- [ ] Run `npm --prefix web test -- DiagnosisView` (green).
- [ ] Commit: `feat(diagnosis): report title/tags/delete UI`.
