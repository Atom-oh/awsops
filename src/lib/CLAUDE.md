# Lib Module / 라이브러리 모듈

## Role / 역할
Core libraries: Steampipe database connection, SQL query definitions, and shared utilities.
(핵심 라이브러리: Steampipe 데이터베이스 연결, SQL 쿼리 정의, 공유 유틸리티.)

## Key Files / 주요 파일
- `steampipe.ts` — pg Pool connection (max 3, 120s timeout), batchQuery, node-cache (5 min TTL)
  (pg 풀 연결: 최대 3개, 120초 타임아웃, 배치 쿼리, 5분 TTL 캐시)
- `queries/*.ts` — 16 SQL query files (one per AWS/K8s service)
  (16개 SQL 쿼리 파일 — AWS/K8s 서비스별 1개)

## Rules / 규칙
- ALL database access goes through `steampipe.ts` `runQuery()` or `batchQuery()`
  (모든 데이터베이스 접근은 `steampipe.ts`의 `runQuery()` 또는 `batchQuery()`를 통해 수행)
- Never use Steampipe CLI — pg Pool is 660x faster
  (Steampipe CLI 사용 금지 — pg Pool이 660배 빠름)
- Steampipe runs with `--database-listen network` (VPC Lambda access on :9193)
  (Steampipe는 `--database-listen network`으로 실행 — VPC Lambda가 :9193으로 접근)
- Verify column names against `information_schema.columns` before writing queries
  (쿼리 작성 전 `information_schema.columns`로 컬럼명 확인)
- No `$` in SQL — use `conditions::text LIKE '%..%'` instead of `jsonb_path_exists`
  (SQL에서 `$` 사용 금지 — `jsonb_path_exists` 대신 `conditions::text LIKE '%..%'` 사용)
- Avoid SCP-blocked columns in list queries: `mfa_enabled`, `attached_policy_arns`, Lambda `tags`
  (목록 쿼리에서 SCP 차단 컬럼 사용 금지: `mfa_enabled`, `attached_policy_arns`, Lambda `tags`)
- See CLAUDE.md root "Steampipe Queries" section for column name gotchas
  (컬럼명 주의사항은 루트 CLAUDE.md의 "Steampipe Queries" 섹션 참조)
