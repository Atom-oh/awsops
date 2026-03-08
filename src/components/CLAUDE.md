# Components Module / 컴포넌트 모듈

## Role / 역할
Shared React components used across pages. Layout components, cards, charts, and UI primitives.
(페이지 전반에 걸쳐 사용되는 공유 React 컴포넌트. 레이아웃 컴포넌트, 카드, 차트, UI 기본 요소.)

## Key Files / 주요 파일
- `layout/Sidebar.tsx` — Main navigation (6 groups) (메인 네비게이션, 6개 그룹)
- Reusable cards: StatsCard, LiveResourceCard (재사용 가능 카드)
- Chart wrappers using Recharts (Recharts 기반 차트 래퍼)
- Network topology using React Flow (React Flow 기반 네트워크 토폴로지)

## Rules / 규칙
- All components use `export default`
  (모든 컴포넌트는 `export default` 사용)
- Tailwind classes use theme tokens (navy-*, accent colors)
  (Tailwind 클래스는 테마 토큰 사용: navy-*, 강조색)
- Color prop accepts name strings ('cyan', 'green', 'purple') not hex values
  (color 속성은 hex 값이 아닌 이름 문자열 허용: 'cyan', 'green', 'purple')
