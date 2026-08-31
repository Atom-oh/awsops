# AI-diagnosis parity batch — 5 gap-audit items (L49–L53)
# AI 진단 패리티 배치 — 갭 감사 5건 (L49–L53)

**Status:** Batch 8, 2026-08-31 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/ai-diagnosis-batch`.
**WA pillar:** Operational Excellence (report navigability, scheduling control, notification
verification); no new AWS-mutation path beyond one scoped `sns:Publish` (see §5).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L49 (TOC sidebar + collapse +
severity icons), L50 (report language selection), L51 (schedule detail settings + last run),
L52 (diagnosis page i18n — mostly stale, see §4), L53 (test notification button).

## 요약 (한국어)

AI 진단의 v1 패리티 5건을 한 PR로 복원한다: 완료 리포트의 섹션 카드 + TOC 사이드바 +
심각도 아이콘, 리포트 생성 언어 선택(ko/en/zh/ja), 스케줄 상세(요일/날짜/시각 KST + 최근
실행 표시), 페이지 헤더 i18n 마감, 관리자 테스트 알림 발송. 서버 측 추가는 report 잡
payload의 `lang`, 스케줄 `config`의 상세 키, 테스트 발송 라우트 1개 + `sns:Publish` IAM
1건(기존 진단 토픽 한정)이다.

## 1. Report TOC sidebar + per-section collapse + severity icons (L49)

Client-side only — the stored markdown format is unchanged.

- New `web/components/diagnosis/ReportSections.tsx`: splits `markdown` on `\n## ` headings
  (the worker emits one h2 per section; `report.py:202-214`). The preamble (title line,
  생성 일시, and the `**목차**` link list — whose `#{key}` anchors are DEAD today since
  `ReportMarkdown` emits no heading ids) renders once at the top with the dead TOC list
  **stripped** (the UI TOC replaces it; the raw .md download keeps it).
- Each section renders as a collapsible card: h2 title row (click toggles), severity icon,
  body via the existing `ReportMarkdown` (reuse — its `normalizeHeadings` and overrides
  apply per section). All expanded by default; a 모두 접기/모두 펼치기 control.
- Sticky TOC sidebar (right side, hidden below `lg:`): section titles + severity icons;
  click scrolls to the card (`scrollIntoView({behavior:'smooth'})`) and expands it if
  collapsed.
- Severity per section: the VERBATIM `[Critical]`/`[Warning]` markers only (the prompts
  prescribe them in every language and `LANG_RULES` keeps them verbatim — prose keywords
  false-positive on the prompt-mandated '심각도' table column); a degraded/failed section body
  renders the warning icon, never green. This is a display heuristic, not a verdict — the icon
  carries a title tooltip saying "본문 키워드 기반" so it can't be read as a scored severity.
- Fallback: markdown with no `## ` heading (legacy/failed shapes) renders exactly as today
  (single `ReportMarkdown`).
- `DiagnosisView` swaps `<ReportMarkdown>` for `<ReportSections>` in the completed-report
  branch only.

## 2. Report language selection (L50)

`lang ∈ ['ko','en','zh','ja']`, default `'ko'`. v1 parity is ko/en/zh; ja is included because
v2's `SUPPORTED_LANGS` already ships a ja UI — a ja UI user getting a ko-only report is the
same gap. Report body language is what changes; section keys/ids stay ASCII.

- **UI**: language `<select>` in `DiagnosisView`'s run controls (below tier), defaulting to
  the current UI language (synced post-hydration until the user picks one). The chosen lang is
  sent in the POST body and applies to that run only — no report-list badge (the language is
  visible in the report body itself).
- **BFF** `web/app/api/diagnosis/route.ts`: accept `body.lang` against the 4-value allowlist
  (400 otherwise; missing → 'ko'); **include `lang` in the idempotency key** (today's key
  `report:{identity}:{tier}:{model}:{scope}:{hour}` would silently dedupe a language switch
  within the hour onto the previous language's report); pass `lang` through `enqueueJob`'s
  payload.
- **Worker**: `handlers.py _report` reads `payload.lang` (default 'ko', allowlist-validated
  fail-closed to 'ko'); `report.py generate(..., lang='ko')` threads it to:
  - `sections.py`: `_RULES`' hardcoded '한국어로 답하라' becomes a per-lang instruction map
    (`LANG_RULES: {ko,en,zh,ja}`) appended per render;
  - `report.py _TITLE_PROMPT` (title in the report language);
  - `build_markdown` / `_coverage_note` document chrome (title line, 생성 일시 label, 목차
    label, coverage heading) via a small per-lang chrome map, and the 7 Korean deep-section
    titles via `TITLES_I18N` (section keys stay stable; the degraded-section placeholder is
    localized too, keeping 'degraded' verbatim for the UI severity heuristic). Section prompt
    *bodies* stay as they are — the lang instruction governs the output language (v1 did the
    same). The data-coverage appendix body stays Korean by design (operator diagnostics).
  - This map is a NEW manual i18n lockstep site (alongside `agent/agent.py`'s map and
    `bedrock-direct.ts`) — recorded in web/lib/CLAUDE.md's list in this PR.
- **Schedules**: `config` JSONB gains optional `lang` — PUT validation (same allowlist),
  `SchedulePanel` select, `schedule_dispatcher._enqueue_report` forwards `cfg.get("lang")`.
- Reports table: no schema change — `lang` rides in the job payload and the rendered body.

## 3. Schedule detail settings + last run (L51)

No schema migration — the detail fields live in the existing `report_schedules.config` JSONB.

- **Fields** (all optional, defaults preserve today's behavior):
  - weekly/biweekly: `dayOfWeek` 0–6 (KST, 0=일).
  - monthly: `dayOfMonth` 1–28.
  - all: `hour` 0–23 (KST). Default when absent: current behavior (pure interval from now).
- **BFF**: PUT validates the fields per scheduleType (400 on out-of-range);
  `computeNextRun` (web/lib/diagnosis-schedule.ts) computes the first occurrence honoring
  the detail fields **in KST** (Asia/Seoul, UTC+9 fixed — no DST), always strictly in the
  future.
- **Dispatcher** (`schedule_dispatcher.py`): keep the advance-first `_CLAIM_SQL` exactly as
  is (its coarse interval advance is the double-claim guard). After a successful claim,
  when the claimed row's `config` carries detail fields, compute the precise next
  occurrence in Python (KST) and issue a follow-up
  `UPDATE report_schedules SET next_run_at = %s WHERE user_sub = %s AND schedule_type = %s
  AND next_run_at = %s` (guarded on the claimed value so a user's concurrent save between the
  claim and the refinement is never overwritten) — idempotent, single hourly Lambda, and a
  crash between the two UPDATEs degrades to today's coarse interval (never a double run,
  never a stall). An `hour` without its cadence partner field (dayOfWeek/dayOfMonth) keeps
  the coarse interval date with the hour pinned in KST — it never invents a run date.
- **UI** (`SchedulePanel`): dayOfWeek select (weekly/biweekly), dayOfMonth select 1–28
  (monthly), hour select 00–23시 (KST) — and render the already-fetched `lastRunAt`
  ("최근 실행: …", KST) next to the existing 다음 실행 line.

## 4. Diagnosis page i18n (L52 — audit row is largely stale)

Verified 2026-08-31: `DiagnosisView`/`SchedulePanel`/`SubscribersPanel` already wrap every
user-facing string in `tt()`, and `i18n-terms.ts` TERMS/RULES already carry en/zh/ja for
them — the audit row predates that work. What actually remains:

- `web/app/ai-diagnosis/page.tsx` is a server component with two hardcoded Korean strings
  (already registered in TERMS but never applied). Fix: make the page a thin client
  component (`'use client'`, `useI18n`) matching sibling pages.
- Every NEW string this batch introduces is registered in TERMS (en/zh/ja) in the same PR.
- The audit row is ticked with an inline note: already-shipped via tt()/TERMS; this batch
  closed the page-header remainder.

## 5. Test notification button (L53)

- **Route**: new `POST /api/diagnosis/subscribers/test` — same guards as the sibling
  mutations (`verifyUser` + `isAdmin` + `topicArn()` gate; 404-when-disabled matches GET's
  `enabled:false` contract). No body. Publishes one SNS message; returns `{messageId}`.
- **Lib**: `web/lib/diagnosis-notify.ts` gains `publishTest()` — `PublishCommand` with the
  ASCII subject `[AWSops] Test Notification` (SNS rejects non-ASCII subjects — same
  constraint as the worker's `_SUBJECT`) and a short bilingual body. The triggering admin's
  identity deliberately stays OUT of the body (it would broadcast an email address to every
  subscriber) — the route's server log carries the audit trail. A publish failure returns 502 with a SANITIZED message
  ('publish failed' — SNS errors embed role/topic ARNs; the detail is logged server-side
  only). No silent success.
- **IAM** (`terraform/v2/foundation/notify.tf`): add `sns:Publish` to the existing web-task
  policy `task_diagnosis_notify`, scoped to the one diagnosis topic ARN (the policy — and
  the topic itself — already exist only when `diagnosis_notify_enabled=true`). This is a
  notification publish to the app's own SNS topic, mirroring what the worker roles already
  hold — not an AWS-resource mutation; ADR-005's freeze (infra mutation/remediation) is not
  touched, and the existing in-policy comment explaining why web lacked Publish is updated
  to name the test-send carve-out.
- **UI**: `SubscribersPanel` gains a 테스트 발송 button (visible only when `canManage` and
  ≥1 confirmed subscriber), with sent/failure inline feedback. New
  `SubscribersPanel.test.tsx` (the one untested diagnosis component) covers the button
  gating + the disabled/panel-hidden state.

## Out of scope
- Other ai-diagnosis audit rows (L176 elapsed timer, L177 per-section progress grid, L178
  notify on/off toggle, L179 print view, L180 idle section preview, L181 row downloads) —
  later batch.
- Localizing section prompt *bodies* or historical stored reports (the lang instruction
  governs new output only).
- Schedule day-of-week for `monthly` / day-of-month for `weekly` (not meaningful).

## Testing
- `ReportSections.test.tsx`: split on h2, preamble TOC stripped, severity icon mapping
  (critical > warning > ok), collapse toggle, no-`##` fallback renders single document.
- `api/diagnosis/route.test.ts` (extend): lang allowlist 400; lang in idempotency key
  (ko then en within the hour → two jobs); default ko.
- `schedule/route.test.ts` (extend): detail-field validation per scheduleType.
- `diagnosis-schedule` unit: computeNextRun KST honoring dayOfWeek/dayOfMonth/hour, always
  future.
- `SchedulePanel.test.tsx` (extend): detail controls render per cadence; lastRunAt shown.
- `SubscribersPanel.test.tsx` (new): test-send button gating + POST wiring.
- Python: `test_schedule_dispatcher.py` (extend) — precise next-run follow-up UPDATE;
  `diagnosis/test_report.py` (extend) — lang threading + chrome map.
- Full `npm test` + `tsc` + `npm run build`; gap-audit ticks with a batch-8 note.
