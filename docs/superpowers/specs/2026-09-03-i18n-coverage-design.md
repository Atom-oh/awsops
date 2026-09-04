# i18n coverage completion + lockstep guard — 4 gap-audit items (L186, L206, L207, L254)

**Status:** Batch 40, 2026-09-03 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch40`.
**WA pillar:** Operational Excellence (a 4-language UI that actually translates).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L186 (cloudfront i18n), L206
(datasources i18n), L207 (dynamodb i18n), L254 (waf i18n).

## Decisions

- **These four items share ONE mechanism and are mostly already solved**: cloudfront/
  dynamodb/waf all render through the generic `/inventory/[type]` page, and v2's `tt()`
  translation (SUPPORTED_LANGS ko/en/zh/ja — one MORE language than v1's 3) already covers
  the Korean UI strings the audit flagged ('총 N', '검색…', '전체 해제', '로딩 중…', …). The
  audit items predate the tt() rollout. What remained was VERIFICATION plus the residue:
  - 17 unregistered Korean literals on the datasources surfaces (DatasourceForm,
    DatasourcesTab, CardDashboard, ExplorePanel) — registered in en/zh/ja;
  - the composed donut title `'<label> 분포'` (+ optional `' (표본 기준)'` suffix) had no
    RULE — added, so donut titles translate instead of passing through Korean-mixed.
- **Lockstep guard**: `web/lib/i18n-coverage.test.ts` extracts every Korean `tt('…')`
  literal on exactly these surfaces (the generic [type] page + the datasources components)
  and asserts each resolves in en/zh/ja via `applyTerms` (an unregistered literal passes
  through unchanged — that IS the failure, named in the assertion message). Sanity guards
  pin that the glob finds the surfaces and that >30 literals were actually scanned (an
  empty scan proves nothing).
- **Disclosed deviations** (recorded in the audit ticks):
  - spec/column labels deliberately stay ENGLISH across locales (the repo's
    technical-identifiers convention, components/CLAUDE.md) — v1 translated them; v2 keeps
    one canonical form;
  - the guard watches these four surfaces; Korean literals on OTHER pages are out of this
    batch's scope (they share the same tt() mechanism and registry).
- Drive-bys: the batch-39 locale guides' literal `(표본 기준)` parenthetical now names each
  locale's actually-rendered term (en 'sampled', zh '（基于样本）', ja '（サンプル基準）' —
  the round-3 chair note on PR #287); the audit's L110 tick gains the batch-39 correction
  pointer (the true total now comes from `view=agg`, not the summary endpoint).

## Testing
- lib/i18n-coverage.test.ts (the lockstep guard, with scan-size sanity assertions).
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; audit ticks +
  batch-40 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **The sampled donut title translates at runtime (the gate MAJOR)** — the composed title
  pre-translated the qualifier (`` ` (${tt('표본 기준')})` ``), so the string reaching Card's
  single tt() was Korean-mixed (`Type 분포 (sampled)`) and matched NO rule — the exact case
  the RULE was added for was dead. Titles are now composed FULLY in Korean (donuts and the
  histogram bar) and one tt() pass translates them; a generic `<label> (표본 기준)` suffix
  RULE covers English chart labels. The new donut RULE's ja phrasing folds to the
  pre-existing `の分布` (it supersedes — first-match-wins — the older plain rule, which is
  removed deliberately as dead code).
- **The guard is an honest ratchet and the residue is closed (the gate MAJOR)** — the scan is
  recursive (readdirSync — no fs.globSync Node/types floor question; `[id]/page.tsx` now
  included) and also matches interpolation-free template literals. The dynamic tt(variable)
  paths are covered by REGISTERING their finite catalogs (card_catalog.py's 9 titles,
  datasource-render.ts's 6 notes — lockstep comments point both ways), a RULE covers the
  parameterized series-cap note and the log-view caption, and ExplorePanel's raw
  `result.note` renders are tt()-wrapped. The guard's comment/spec/CHANGELOG now say
  RATCHET, not completeness proof.
- **The over-claims are corrected (the gate MAJOR)** — the two English action buttons
  ('＋ Add datasource', '🧪 Test connection') are localized via Korean sources (buttons are
  not covered by the technical-identifier carve-out); the L207/L254/L186 ticks carry the
  English-column-label 부분 편차 marker inline; the CHANGELOG bullet states the precise
  coverage and the ratchet framing.

## Round-2 corrections (review-driven)

- **The card_catalog lockstep is complete (the gate MAJOR)** — the round-1 registration
  missed BOTH ClickHouse card titles ('최근 1시간 스팬 수', '서비스별 스팬 Top5 (1h)'), so
  every ClickHouse dashboard card stayed Korean in en/zh/ja — the exact dynamic path this
  batch claims to close, structurally invisible to the static ratchet. Both are registered.
- Minors closed: parameterized RULES for the two interpolated FAILURE notes
  ('지원하지 않는 데이터소스: <kind>', '결과 파싱 실패: <message>' — the notes that explain
  WHY a result is unusable now translate like the trivial empties); the log-view caption pins
  `toLocaleString('en-US')` so its RULE matches under any runtime locale; DiagSignalChips
  wraps its catalog titles in tt() and the 9 diagnosis signal titles are registered (lockstep
  with signal_catalog.py); the DatasourcesTab row actions (Explore/Edit/Delete) are localized
  via Korean sources (편집/삭제/탐색 — Edit/Delete/Explore in en).
- Advisory (untouched-by-diff, recorded): the countBar/flagBar sampled titles still use the
  pre-translated suffix — English labels + a registered TERM mean nothing renders Korean,
  only a zh/ja paren-style inconsistency; unify opportunistically next time those lines
  change.
