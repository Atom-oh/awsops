# 컴포넌트 모듈 / Components Module

## 역할 / Role
클라이언트 컴포넌트 83개, 11개 서브디렉토리: `ui`(공용 프리미티브), `shell`(AppShell·Sidebar·LanguageProvider·AccountSelector 등), `charts`, `chat`, `inventory`(+`metrics/`), `eks`, `diagnosis`, `datasources`, `insights`, `nfm`, `overview`.
(83 client components across 11 subdirs: shared primitives in `ui/`, app shell, and domain components.)

## 주요 파일 / Key Files
- `ui/DataTable.tsx` + `ui/DetailPanel.tsx` — 목록+상세 기본 조합. DetailPanel은 행이 이미 들고 있는 전체 데이터를 추가 fetch 없이 렌더 — `spec`(`InvType`)에 `sections`가 있으면 섹션 그룹 렌더, 없으면 flat key 목록(하위호환). 신규 인벤토리 타입은 `sections` 정의 필수 (renders the full row; grouped sections when the spec provides them)
- `inventory/metrics/MetricTable.tsx` — 선언적 `MetricCol` 모델(`{value, render?, danger?, facet?, type}`)만 정의하면 정렬·전역 검색·facet 필터·'문제만' 토글이 무료 제공. 서비스별 테이블(Ec2/Rds/Alb/...)은 컬럼 정의로만 작성 (declarative column model — sort/search/facet/danger-only for free)
- `inventory/metrics/guides.tsx` + `guides.{en,zh,ja}.tsx` — 진단 가이드 언어별 본문. i18n lockstep — 4개 파일 동시 갱신 (per-language guide bodies, update all four together)
- `shell/LanguageProvider.tsx` — `useI18n()` 훅 (`t`/`tt`/lang 컨텍스트) (i18n context hook)
- `shell/Sidebar.tsx` — 내비게이션. 새 페이지 등록 지점 (navigation; where new pages register)
- `ui/StatCard.tsx` — `StatTile`의 alias re-export. 새 코드는 `StatTile` 직접 import

## 규칙 / Rules
- 페이지에서 소비하는 컴포넌트는 `export default`. 단, 공유 유틸 모듈(`metrics/shared.tsx`, `guides.*.tsx`, `LanguageProvider.tsx` 등)은 named export가 기존 패턴 — 임의 변경 금지.
- 새 UI는 `ui/` 프리미티브(Badge, StatePill, Card, PageHeader, StatTile 등) 재사용 우선 — 프리미티브 신설 남발 금지.
- 사용자 표시 문자열은 한국어 리터럴 + `tt()` 경유 (미등록 문자열은 통과되므로 안전).
- 테스트는 컴포넌트 옆 `*.test.tsx` colocate (vitest).
