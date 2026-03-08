# Skill: Code Review / 스킬: 코드 리뷰

## When to Use / 사용 시점
Review any changed page, component, query file, or API route before merging.
(머지 전에 변경된 페이지, 컴포넌트, 쿼리 파일 또는 API 라우트를 리뷰합니다.)

## Checklist / 체크리스트

### Query Files / 쿼리 파일 (`src/lib/queries/*.ts`)
- [ ] Column names verified against `information_schema.columns` (컬럼명을 `information_schema.columns`로 검증)
- [ ] No SCP-blocked columns in list queries: mfa_enabled, tags, attached_policy_arns (목록 쿼리에 SCP 차단 컬럼 없음)
- [ ] Uses `trivy_scan_vulnerability` not `trivy_vulnerability` (`trivy_vulnerability`가 아닌 `trivy_scan_vulnerability` 사용)
- [ ] No `$` character in SQL — use `::text LIKE` instead (SQL에 `$` 문자 없음 — `::text LIKE` 사용)
- [ ] CloudTrail queries use lazy-load, not page-level fetch (CloudTrail 쿼리는 지연 로딩 사용, 페이지 수준 fetch 아님)

### Page Files / 페이지 파일 (`src/app/*/page.tsx`)
- [ ] Starts with `'use client'` (`'use client'`로 시작)
- [ ] fetch URL uses `/awsops/api/steampipe` prefix (fetch URL이 `/awsops/api/steampipe` 접두사 사용)
- [ ] Components imported as default: `import X from '...'` (컴포넌트는 default import: `import X from '...'`)
- [ ] StatsCard/LiveResourceCard color uses name ('cyan') not hex (색상은 hex가 아닌 이름('cyan') 사용)
- [ ] Detail panel follows Section/Row pattern (상세 패널은 Section/Row 패턴 준수)
- [ ] Loading skeleton shown while data loads (데이터 로딩 중 스켈레톤 표시)
- [ ] Error states handled gracefully (오류 상태를 적절히 처리)

### API Routes / API 라우트 (`src/app/api/*/route.ts`)
- [ ] Input validation present (입력 검증 존재)
- [ ] Errors return proper HTTP status codes (오류 시 적절한 HTTP 상태 코드 반환)
- [ ] No secrets hardcoded — use env vars (시크릿 하드코딩 금지 — 환경 변수 사용)
- [ ] Steampipe queries go through `runQuery()` or `batchQuery()` (Steampipe 쿼리는 `runQuery()` 또는 `batchQuery()` 사용)

### General / 일반
- [ ] No `console.log` left in production code (프로덕션 코드에 `console.log` 남기지 않음)
- [ ] TypeScript: no `@ts-ignore` without justification (TypeScript: 근거 없는 `@ts-ignore` 금지)
- [ ] Tailwind classes use theme tokens (navy-*, accent-*) (Tailwind 클래스는 테마 토큰 사용)
