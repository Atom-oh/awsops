# Chart form-fit pass 2 (dataviz methodology) — remaining pages

**Status:** Batch 45, 2026-09-04. Owner follow-up to batch 44: "다른 페이지들도 차트 형태
점검해서 추가 적용해줘" — the same job→form procedure applied to every remaining page's
charts. Branch `feat/batch45`.
**WA pillar:** Operational Excellence.

## Survey result (every chart on the remaining pages classified by job)

Swapped (job = close-magnitude RANKING, wrongly encoded as slice angles):
1. **/eks 'Instance Types'** donut → `BarDistribution` — the exact mismatch batch 44 fixed on
   the home page (nominal types, many close values); client-side aggregation over reachable
   fleet nodes (no server cap — no truncation disclosure needed, unlike the home card).
2. **/eks/cost 'Namespace별 비용'** donut → `BarDistribution` with `$` — namespaces are
   nominal identities ranked by cost; the donut folded 9+ namespaces into 기타 and made close
   $ values incomparable.
3. **/dns-query '쿼리 타입 분포'** donut → `BarDistribution` — record types (A/AAAA/CNAME/…)
   are nominal with a magnitude job; its neighbor 'RCODE 분포' KEEPS the donut (status
   semantics with fixed RCODE_COLORS — part-to-whole of good/bad outcomes).

Deliberately KEPT (job really is part-to-whole / status share / established design):
- cost '비용 구성' donut — the deliberate composition companion to the '서비스별 비용'
  ranking bars (two DIFFERENT jobs over the same rows, a designed v1-parity pair);
- eks + eks/[cluster] 'Pod Status', 'Service Types', compliance 'Controls by status',
  network-firewall '룰 그룹 타입/히트 액션/Flow 프로토콜' (≤4-class shares, some status-
  colored), dns 'RCODE 분포', home '작업 상태' — all genuine share-of-whole reads;
- every AreaTrend/MultiLineTrend (trend job), GroupedBarList (mixed-unit grouped design,
  batch 34), compliance/security bar charts (already magnitude bars).

## Batch-44 review follow-ups closed (chair-endorsed minors)

- home EC2 top-10 subtitle now renders only when the cap is plausibly binding
  (`ec2Types.length === 10`) — an under-10 scope no longer asserts truncation;
- `DivergingBarList` renders '—' (no bar, muted label) for a NON-FINITE value instead of a
  confident `$0` (the repo's never-fabricate-a-0 posture, now that it is a shared primitive);
- the mobile-hidden `sub` figure is still reachable via a `title` tooltip on the value;
- Bedrock `pairRows` aggregates by label (regional id variants share a label — the previous
  rows collided as React keys and double-listed the model).

## Testing
- DivergingBarList: non-finite row renders '—' with no bar on either pole; sub title fallback.
- Bedrock label-aggregation covered indirectly via existing page render tests if present;
  pairRows logic kept inline (page-level, no test harness — matches the repo pattern).
- Full `npm test` + `tsc` non-test + build + `pytest scripts/v2/{workers,steampipe}`;
  CHANGELOG EN/KO (amend the batch-44 form-fit bullet in place — same feature, second pass);
  docs-site guides updated only where they name the swapped chart's form (dns/eks/eks-cost).
