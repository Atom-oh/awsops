# Plan — OpenCost 클러스터 collapse 배너 통합 (read-only)

**Spec:** `docs/superpowers/specs/2026-06-13-opencost-cluster-banner-design.md`
**Branch:** `feat/v2-architecture-design` · **Base:** `main`
**Approach:** TDD (failing test → minimal code → refactor), Tidy First, 태스크당 1 커밋.

## Files in scope

- `web/app/api/me/route.ts`
- `web/app/api/me/route.test.ts`
- `web/app/eks/[cluster]/OpencostPanel.tsx`
- `web/app/eks/[cluster]/OpencostPanel.test.tsx`
- `web/app/eks/[cluster]/page.tsx`
- `web/app/eks/[cluster]/cluster-tabs.test.tsx`
- `web/app/opencost/page.tsx`
- `web/app/opencost/opencost-page.test.tsx`
- `web/components/shell/Sidebar.tsx`
- `web/components/shell/CommandPalette.tsx`
- `web/lib/i18n.ts`

재사용(무변경, 호출만): `web/lib/opencost.ts`, `web/lib/opencost-status.ts`,
`web/lib/opencost-config.ts`, `web/lib/opencost-allowlist.ts`,
`web/app/api/opencost/[cluster]/{route,status/route,bundle/route}.ts`.

## Task 1 — `/api/me` 가 `isAdmin` 를 노출

read-only 백엔드 변경. 패널의 admin 가시성 신호. 권한 강제는 PUT 서버가 그대로 유지.

- [ ] `web/app/api/me/route.test.ts`: `@/lib/admin`의 `isAdmin` 를 mock. "200 with identity"를
      `isAdmin` 포함으로 갱신하고, (a) admin → `isAdmin:true`, (b) 비admin → `isAdmin:false`
      2케이스 추가.
- [ ] `web/app/api/me/route.ts`: `import { isAdmin } from '@/lib/admin'` → `const admin = await
      isAdmin(user)` → 응답에 `isAdmin: admin` 추가.
- [ ] `cd web && npx vitest run app/api/me` 그린.
- [ ] commit: `feat(opencost): /api/me exposes isAdmin for client admin gate`

## Task 2 — `OpencostPanel` 컴포넌트 (TDD)

`export default function OpencostPanel({ cluster })`, client component. 기존 status/bundle/config
API와 `/api/me`만 호출. 모든 fetch 실패는 throw 금지(degrade).

- [ ] `web/app/eks/[cluster]/OpencostPanel.test.tsx` (jsdom): fetch를 경로별로 mock
      (`/api/me`, `/api/opencost/{c}/status`, `/api/opencost/{c}`, `/api/opencost/{c}/bundle`).
      검증:
  - 로딩 → "조회 중…" 류 한 줄
  - status 404 → "인-앱 조회 미온보딩" 안내, 다운로드 버튼 없음
  - 미설치(`installed:false`, reason 없음) → collapse 자동 펼침 + values.yaml·install.sh 버튼
  - degraded(`installed:false` + `reason`) → 펼침 + reason 표시
  - 설치됨·Ready → 닫힘 + positive 배지
  - 설치됨·Not Ready → brand 배지
  - admin 게이트: `isAdmin:true` → 고급 섹션 보임 / `false` → DOM에 없음
  - 다운로드 버튼 클릭 → `/api/opencost/{c}/bundle` fetch 호출(Blob/anchor mock)
  - status fetch reject → throw 없이 degrade 한 줄
- [ ] `web/app/eks/[cluster]/OpencostPanel.tsx` 구현: 6상태 + collapse(`aria-expanded`) +
      미설치 자동 open(최초 1회 초기화) + admin 고급(chart version + override JSON + 저장 PUT) +
      번들 다운로드. `Badge`/`Card` 등 기존 토큰 재사용.
- [ ] `cd web && npx vitest run app/eks/\[cluster\]/OpencostPanel` 그린.
- [ ] commit: `feat(opencost): per-cluster OpencostPanel (read-only status + install guide)`

## Task 3 — 클러스터 상세 페이지에 패널 배선

- [ ] `web/app/eks/[cluster]/cluster-tabs.test.tsx`: 기존 fetch mock을 확장해 `/api/me`,
      `/api/opencost/...` 경로에도 응답(패널이 기존 KPI 테스트를 깨지 않도록) + 패널이
      렌더되는지 assertion 1개(예: "OpenCost" 헤딩).
- [ ] `web/app/eks/[cluster]/page.tsx`: `OpencostPanel` import → 탭 `SegmentedControl` div
      직후 `<OpencostPanel cluster={cluster} />` 삽입(탭 무관 항상 표시).
- [ ] `cd web && npx vitest run app/eks/\[cluster\]` 그린.
- [ ] commit: `feat(opencost): mount OpencostPanel on the cluster detail page`

## Task 4 — top-level OpenCost 제거

- [ ] `git rm web/app/opencost/page.tsx web/app/opencost/opencost-page.test.tsx`
- [ ] `web/components/shell/Sidebar.tsx`: `/opencost` NavItem 줄 제거; 미사용된 `PiggyBank`
      import 제거(EKS NavItem은 유지).
- [ ] `web/components/shell/CommandPalette.tsx`: `/opencost` fixed 엔트리 제거.
- [ ] `web/lib/i18n.ts`: `nav.opencost` 키 2곳(ko/en) 제거.
- [ ] `bash tests/run-all.sh` 그린 + `cd web && npm run build` 그린(미사용 import/참조 없음 확인).
- [ ] commit: `refactor(opencost): drop standalone /opencost page, nav, palette, i18n`

## 검증 (전체)

- 전 태스크 후 `bash tests/run-all.sh` + `cd web && npm run build` 그린.
- read-only 불변식: 패널/라우트 어디에서도 클러스터를 mutate하지 않음(번들 다운로드만).
