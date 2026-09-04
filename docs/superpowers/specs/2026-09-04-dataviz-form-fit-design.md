# Chart form-fit pass (dataviz methodology) — content-appropriate chart variety

**Status:** Batch 44, 2026-09-04. Owner-directed goal: "/dataviz 을 사용해서 단조로운 차트
종류를 조금 더 컨텐츠에 맞게 적용" — apply the dataviz skill's form-selection procedure
(the data's JOB picks the chart type) to the surfaces where the current form mismatches the
job. Branch `feat/batch44`.
**WA pillar:** Operational Excellence (charts that answer the question their data poses).

## Method (from the dataviz skill)

Form before color: magnitude → bar; polarity (±/baseline) → DIVERGING bar; part-to-whole
(≤6+Other) → donut/stacked; identity → categorical; a single number → stat tile. Anti-patterns
consulted: "a donut for comparing close values", "eight hues when the story is one number".

## Changes (job → form corrections)

1. **NEW `DivergingBarList` primitive** (`web/components/charts/DivergingBarList.tsx`) —
   signed horizontal bars centered on a shared zero axis: WARM pole for positive (cost
   increase — the `negative` STATUS token, deliberately not `brand`: in the default theme
   brand-500 equals the positive teal, which would collapse the diverging poles into one
   hue; the page's previous ± text colors had exactly that defect), cool `positive` pole
   for negative (decrease), a neutral hairline zero rule, thin 10px marks with rounded data
   ends, right-aligned tabular signed values, per-row secondary sub-value slot. Pure
   HTML/flex like HBarList (no recharts), one axis; no dual scale.
   **Palette validated with the skill's validate_palette.js** — light #D13212↔#01A88D:
   CVD ΔE 13.9, normal 31.9, all PASS (contrast WARN on the teal is relieved by the visible
   signed label every row carries); dark #F26B4D↔#2CC9AE: CVD 12.2 / normal 29.5 / contrast
   PASS, with a DISCLOSED deviation on the dark lightness band — these are the app's global
   semantic status tokens shared by every surface (meters, badges, KPIs); re-stepping them is
   a design-system change out of a chart-form pass's scope, and the sign + per-row label are
   the secondary encoding.
2. **Home '월 비용 영향 추정'**: the plain ± text list becomes a DivergingBarList — the data's
   job is POLARITY (monthly $ impact above/below zero), the canonical diverging-bar case.
   Sub-value keeps the 30d count delta; the ordering (|impact| desc) and the honesty gates
   (coverage/scope/staleness) are untouched; increase reads on the warm/negative pole,
   decrease on the positive pole (fixing the old list's brand-vs-positive same-teal text).
3. **Home 'EC2 인스턴스 유형'**: donut → `BarDistribution` (horizontal bars). Instance types
   are NOMINAL categories whose job is magnitude comparison across many close values — the
   "donut for comparing close values" anti-pattern; the count-desc bar list reads exact
   ranking at a glance. The summary API caps this dataset at the TOP 10 types (LIMIT 10) —
   disclosed in the card subtitle (round-1 correction: the donut's 기타 rollup used to hint
   at partiality, so the bars must state it; the original "no slice ceiling" claim was wrong).
4. **Bedrock '모델별 비용'**: donut → `BarDistribution` with `$` values. Same
   close-magnitude job as its sibling '모델별 호출 수' (already a bar) — the pair now reads
   as one comparable block instead of two encodings of the same identity set.

## Deliberately KEPT as donuts (job really is part-to-whole)

'카테고리별 리소스' (home), 'K8s 파드 상태' (status share), 'Service Types' (≤4 types),
'작업 상태', security severity donuts (v1-parity + semantic status colors + CVE colors),
cost '서비스별 비용' donut, and the generic inventory [type] distribution donuts (spec-driven
part-to-whole with the L102 fleet-aggregate machinery). Swapping those would trade a correct
part-to-whole form for a worse one — this pass changes only mismatches.

## Testing
- DivergingBarList unit tests: zero-centered geometry (positive right / negative left of the
  shared axis), max-|v| scaling, sign-colored fills, signed value formatting, zero rows render
  an empty bar (no fabricated direction), $ prefix.
- Updated page tests if any pin the swapped chart components.
- Full `npm test` + `tsc` non-test + build + `pytest scripts/v2/{workers,steampipe}`;
  CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **The EC2 top-10 cap is disclosed and the false claim is corrected (the gate MAJOR)** — the
  summary API caps instance types at LIMIT 10; the donut's 기타 rollup used to hint at
  partiality, and the swap removed that cue while the CHANGELOG/spec claimed "no slice
  ceiling". The card now carries a '상위 10개 유형만 표시' subtitle (BarDistribution/HBarList
  gain a subtitle passthrough) and the claim is corrected everywhere.
- **DivergingBarList is mobile-safe (the gate MAJOR)** — the fixed w-36 + w-40 columns left
  the flex-1 track ~0px and clipped the signed label (the claimed secondary encoding) inside
  Card's overflow-hidden at ~310px content width. Columns are now responsive
  (w-24/sm:w-36 label, w-28/sm:w-40 value, sub hidden below sm), keys are stable (label, not
  index), and one finite-guard covers both the scale and the row (an Infinity row can no
  longer render width:Infinity%).
- **CHANGELOG amend-in-place restored (the gate MAJOR)** — the existing [Unreleased]
  cost-impact bullet (EN/KO) is amended to describe the diverging-bar form; the batch-44
  bullet keeps only the surfaces with no prior covering entry (the two donut→bar swaps),
  cross-referencing the amended entry for the palette validation.
- Minors closed: the Bedrock pair shares ONE row order (invocations desc + label tiebreak,
  preserveOrder on both) so a model sits on the same row in both charts — sub-cent idle
  models keep their row ($0.00 next to real invocations IS the cheap-but-chatty signal,
  chosen over filtering); the 2×4-locale Bedrock guides (cost + monitoring) now describe
  bars sharing a row order instead of a donut/pie share.
- Recorded (accepted): HBarList forces 2 fraction digits for $ regardless of `decimals`
  (pre-existing; impact values are integral today); the two cost primitives' $ formatting
  differs (toLocaleString vs forced 2 digits) — unify if a fractional-impact source appears;
  the lg-grid column widths for the Bedrock pair are the page's established layout.
