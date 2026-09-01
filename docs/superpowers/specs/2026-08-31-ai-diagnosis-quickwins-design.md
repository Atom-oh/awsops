# AI-diagnosis UI quick wins — 4 gap-audit items (L176, L177, L180, L181)
# AI 진단 UI 퀵윈 — 갭 감사 4건 (L176, L177, L180, L181)

**Status:** Batch 9, 2026-08-31 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/ai-diagnosis-quickwins`.
**WA pillar:** Operational Excellence (generation observability, report accessibility).

Closes: L176 (elapsed timer + post-completion stats bar), L177 (in-progress section checklist
grid), L180 (idle-state section preview), L181 (inline history-row downloads).
Out of scope: L178 (notify on/off toggle — needs a DB flag + worker check, separate M item),
L179 (print view — largely superseded by the shipped PDF export, audit itself rates it low).

## 요약 (한국어)

진단 생성 UX 퀵윈 4건: 생성 중 mm:ss 경과 타이머와 완료 후 통계 바(섹션 수 · 경과 시간 ·
리포트 ID), 생성 중 섹션 체크리스트 그리드(완료/대기 2단계 — 동시 렌더 특성상 스피너 없음), 빈 상태의 섹션
프리뷰 그리드, 히스토리 행 인라인 MD/DOCX 다운로드 링크. 서버 측 변경은 워커
`update_progress`의 progress JSONB `completed`(완료 섹션 제목 배열) 추가와
`diagnosis_reports.finished_at` 추가 마이그레이션 1건(+`finish_report()` 종료 시점 스탬프) —
API/Terraform 변경 없음.

## Decisions

### L176 — elapsed timer + stats bar
- Timer: client-side, from the running report's `created_at` (already on the list row), ticking
  every second while `status === 'running'`, rendered in `ProgressPanel` as `mm:ss`. Server
  clock skew guard: clamp negatives to 0.
- Stats bar: on a completed opened report, one line under the download row:
  `섹션 N개 · 소요 mm:ss · 리포트 #id`. Elapsed = `finished_at − created_at`.
  `diagnosis_reports` had NO finished_at column — this batch adds it (one additive ULID
  migration) and `finish_report()` stamps it at every terminal write; legacy rows stay NULL
  and the 소요 segment is omitted (honest-degrade, no fake duration). Note the duration
  includes queue wait (created_at is stamped at web-tier INSERT). Section count =
  `summary.sections` (already in `ReportSummary`).

### L177 — in-progress section checklist grid
- Worker: `diagnosis/db.py update_progress` gains `completed` — the report.py progress
  callback accumulates the titles of sections that have finished rendering (already known:
  `_emit(done, result["title"], "render")` fires per completion) and writes them as
  `progress.completed: string[]`. Pure additive JSONB key — old rows/readers unaffected.
- `report.py`: thread an accumulated list into `_emit` (order = completion order).
- UI (`ProgressPanel`): when `progress.completed` exists AND the static catalog size matches
  `progress.total` (drift guard — mismatch falls back to the bar-only view), render a grid of
  ALL expected section titles for the run's tier in the UI language — completed → green
  check, rest → dimmed pending. Deliberately NO per-section spinner: render is concurrent
  (RENDER_CONCURRENCY=4) and the persisted payload cannot distinguish in-flight from
  untouched sections, so `progress.section` is the most recently COMPLETED section (the line
  above the grid is labeled 최근 완료 섹션 during the render phase). When `completed` is
  absent (old in-flight rows), keep today's bar-only UI.
- Static catalog: `web/lib/diagnosis-sections.ts` — a hand-mirrored list of the worker's
  section keys/titles per tier (8 base + 7 deep + intended_vs_actual = 16), with a lockstep
  comment pointing at `scripts/v2/workers/diagnosis/sections.py` (same convention as the
  other documented manual lockstep sites) AND an automated pytest lockstep guard
  (`diagnosis/test_sections_mirror.py` parses the TS mirror and compares keys/titles/
  variants). Matching is by title string against BOTH the ko catalog title and its localized
  variants (render is concurrent, so completion order ≠ catalog order — order/count matching
  would be wrong); an unmatched completed title (future drift) simply doesn't check a box —
  never a wrong check.
- Subtopics: v1's SECTION_SUBTOPICS is NOT reproduced (the worker prompts carry the real
  subtopics now); the audit row is ticked with an inline partial note (grid shipped,
  per-section subtopic captions deliberately dropped — the active section title already
  shows). This keeps the static-mirror surface minimal.

### L180 — idle-state section preview
- The empty state (`리포트를 선택하거나 "진단 실행"을 누르세요`) gains a scope paragraph +
  a chip grid of all 16 section titles (UI language) from the same static catalog, with the
  7 deep-only chips tagged `Deep`, so users see what a diagnosis covers before running one.
  Plain text chips — no per-section icons (kept minimal).

### L181 — inline history-row downloads
- Each SUCCEEDED/PARTIAL list row gains two small inline links (`MD`, `DOCX`) to the existing
  `/api/diagnosis/[id]/download?format=` route (PDF stays in the opened-report bar — v1
  parity offered exactly MD/DOCX inline). Stop event propagation so the row click (open)
  doesn't fire.

## Testing
- `ProgressPanel`: timer renders mm:ss from created_at; checklist grid states (completed
  check / pending dim — no spinner by design); absent `completed` or a catalog-size mismatch
  → legacy bar only.
- Stats bar: shown with section count + report id; 소요 omitted when finished_at missing.
- Idle preview: chips render for both tiers; run button still visible.
- Row downloads: links only on succeeded/partial rows; href format; click does not open the row.
- Python: `update_progress` persists `completed`; `generate` accumulates completion titles
  (order-independent set equality).
- Full `npm test` + build + pytest; gap-audit ticks with a batch-9 note (L177 partial note).
