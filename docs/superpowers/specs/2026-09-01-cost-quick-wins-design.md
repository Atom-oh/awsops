# Cost page quick wins: KPI tiles, CE onboarding banner, table encoding — 3 gap-audit items (L196, L197, L198)

**Status:** Batch 24, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch24`.
**WA pillar:** Cost Optimization (spend-surge visibility / onboarding).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L196 (Daily Average + Last Month
tiles, ">20% increasing" sub-metric), L197 (Cost Explorer onboarding banner), L198 (service
table threshold colors + share mini bars).

## Decisions

> NOTE: §Decisions/§Testing describe the ROUND-1 design; the shipped behavior is the
> cumulative result of the correction rounds below (the banner is conditional/probe-driven
> since round 5–7, and lib/cost.ts gained the predicate + UTC alert math).
- **L196** — KPI row grows from 5 to 7 tiles (`lg:grid-cols-4`, wrapping): (a) **Daily
  Average** — mean of the FILTERED daily totals over the trailing-30d series ('—' when the
  series is empty); (b) **Last Month** standalone total ('—' when no prior month); (c) the
  Services tile gains v1's change subtext — 'N개 >20% 증가' counting `changeRows` where
  `change > 20 && previous > 0` (new services with previous=0 have change pinned to 0 by
  `serviceChangeRows` and are never counted as surging).
- **L197** — when the load SUCCEEDED but every series is empty (no monthly, no daily, no
  service rows), an info banner (distinct from the error banner) explains the likely cause:
  Cost Explorer may not be enabled — enable it in the AWS Billing console; data can take up
  to 24h to appear. The existing empty-card texts stay for partial emptiness.
- **L198** — the service detail table moves from DataTable (no cell renderers) to the shared
  `MetricTable` (typed numeric sort + custom renders, the inventory-metrics precedent):
  the Change cell is threshold-colored (>20% red · >0 orange · <0 green; 0/no-baseline
  neutral), and the Share cell renders v1's mini progress bar + percentage. Row click keeps
  opening the service drill-down; numeric sorting now works on real numbers instead of
  formatted strings.

Read-only; no API/Terraform changes. 4-language i18n for the new strings.

## Testing
- Page-level helpers stay in lib/cost.ts (no change); the new tile math is presentational.
- No page-level test is added (decision, not deferral): MetricTable's own suite covers the
  sort/render plumbing, and the banner predicate lives in lib/cost.ts with unit tests.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-24 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **The banner trigger works (the gate MAJOR)** — raw-array emptiness never fires (a zero-
  spend CE response still returns one bucket per period) and the only reachable path (all
  fan-out legs failing in 전체 계정) fired with the WRONG diagnosis. New
  `looksLikeCeUnconfigured` in lib/cost.ts (unit-tested): derived emptiness (total 0, no
  change rows, all-zero trend), unfiltered, load succeeded, and ZERO failed fan-out legs
  (`loadAllAccountsCost` now tracks swallowed leg failures).
- **Header i18n restored (the gate MAJOR)** — MetricTable renders `tt(c.label)` everywhere the
  label reaches the user (passthrough-safe for its existing English call sites), and the new
  tile labels/hint/surge text are registered (RULES patterns `일평균 (X)`, `전월 총액 (X)`,
  `N개 >20% 증가`; TERM `최근 30일 · 필터 적용`).
- No-baseline change rows pass `null` (MetricTable's missing contract — they sort LAST);
  the Last Month dash gates on `monthly.length < 2` (a present $0 prior month renders $0);
  the CHANGELOG bullet is amended in place for the table chrome + mobile layout change.
- Known follow-up (out of scope, v1-parity bias): the change % compares partial MTD to the
  previous full month — per-day normalization would remove the mid-month green bias.

## Round-2 corrections (review-driven)

- **The banner fails closed on every degradation (the gate MAJORs)** — the predicate now also
  requires: NOT a cached-snapshot fallback (`/api/cost` serves last-good bodies as 200 +
  `cached: true`, and the 전체 계정 merge taints on ANY cached leg), a NON-empty daily trend
  (a swallowed daily-leg failure yields [] and `[].every()` is vacuously true), and zero spend
  ACROSS THE FETCHED MONTHLY MATRIX (an account whose spend stopped >30 days ago must never
  read an onboarding banner above real historical bars). All covered by unit tests.
- Daily Average excludes today's still-accumulating CE bucket (the momChangePctDaily caveat);
  the docs-site cost guide (4 locales) documents the 7-tile row, the new tiles/subtext, and
  the onboarding banner.
- Known follow-up (unchanged): per-row day-normalized change % to remove the mid-month
  under-alerting bias in the surge count/coloring.

## Round-3 corrections (review-driven)

- **A failed accounts DISCOVERY counts as a failed leg (the gate MAJOR)** — `/api/accounts`
  down/malformed fell into the pre-existing self-only fallback with `failedLegs: 0`, so a
  live zero-spend host could still read the onboarding banner while member accounts were
  never queried. Discovery failure now taints the merge the same way a fan-out leg failure
  does (banner suppressed; the self-only fallback still renders).
- Daily Average renders '—' when no COMPLETED day exists yet — the fallback had re-admitted
  exactly the partial bucket the exclusion was written for.

## Round-4 corrections (review-driven)

- **The banner is availability-confirmed (the gate MAJOR)** — a narrow period window (1m/3m)
  can be all-empty for an ENABLED CE whose spend predates the window, so derived emptiness
  alone can't assert an onboarding cause. When the emptiness predicate fires, the page now
  probes the purpose-built classifier (`/api/cost/availability`) and renders the banner ONLY
  on a confirmed `reason: 'not_enabled'`.
- **The surge count and threshold coloring are day-normalized (the gate MAJOR)** — the raw
  partial-MTD-vs-full-month ratio reads ≈−50% mid-month at an unchanged run-rate; the table's
  Change column (relabeled '변화율 (일평균)'), its red/green thresholds, and the 'N개 >20%
  증가' subtext all use the same `momChangePctDaily` primitive as the MoM tile. No-baseline
  rows still read '—'.
- Discovery validation covers a 200 with `{}`/`accounts: null` (malformed, counted as a
  failed leg); `mergeCost` propagates the latest `cachedAt` so the stale banner never renders
  empty parentheses in 전체 계정 mode.

## Round-5 corrections (review-driven)

- **TDZ crash fixed (the gate CRITICAL)** — `normChange` was declared ~50 lines below the
  `costRows` map that called it during render; `now`/`normChange` are hoisted above the map.
- **The banner is cause-NEUTRAL and probe-honest (the gate MAJORs)** — the auto-probe is
  gone (billable, host-scoped, and its verdict stuck across account switches). The empty
  state now renders a neutral '선택한 기간에 비용 데이터가 없습니다.' banner with the
  existing force-probe button; the not_enabled onboarding sentence renders only after a
  probe result AND only in host scope (`active === 'self'`) — the availability classifier
  probes with the host task role and must never speak for a member account. Reachability is
  honest by construction: a genuinely-disabled CE takes the error path (classified notice,
  pre-existing), and the empty banner covers the narrow-window/zero-spend states without
  asserting a cause.
- `looksLikeCeUnconfigured` guards the monthly vacuous-every() hole; `mergeCost` keeps the
  OLDEST `cachedAt` (the honest staleness bound for a mixed merge).

## Round-6 corrections (review-driven)

- **UTC alert math (the gate MAJOR)** — the red/surge verdicts now use
  `momChangePctDailyUtc` (CE buckets are UTC calendar months; local `getDate()` inverted the
  verdict for ~9h after every UTC month rollover in KST and skewed elapsed by one day daily).
  The non-alerting MoM tile keeps its pre-existing local behavior. Boundary unit test added.
- **The onboarding hint comes only from a FRESH, user-initiated probe (the gate MAJOR)** —
  the stale global `avail` no longer drives it; the banner's own button force-probes and
  stores a local result cleared on every load; a confirmed-available result renders the
  honest "the period most likely had no spend" line instead. The docs-site (4 locales) now
  describes the conditional flow instead of an unconditional onboarding banner.

## Round-7 corrections (review-driven)

- **Probe-result rendering matches the verdict (the gate MAJOR)** — the "available" line
  renders only on `reason === 'ok'` AND host scope; `access_denied`/`error` render a neutral
  could-not-determine line (never an availability claim the probe failed to establish, never
  a host verdict spoken for a member account). The probe drops `force=1` (the 1h-cached
  verdict suffices; no unthrottled billable button), carries a sequence guard against
  post-switch stale results, and a non-OK response gives explicit feedback.
- **Alert divisor excludes today's partial CE bucket (the gate MAJOR)** —
  `momChangePctDailyUtc` divides by `max(1, getUTCDate() − 1)`, the same completed-days basis
  the Daily Average tile uses; day-2 boundary test added.
- The EN CHANGELOG's inverted color text is fixed to match KO (>0 orange, <0 green); the dead
  round-1 banner TERM is removed.
