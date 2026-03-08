# ADR-001: Steampipe pg Pool over CLI / Steampipe pg Pool과 CLI 비교

## Status: Accepted / 상태: 승인됨

## Context / 컨텍스트
Steampipe can be accessed via CLI (`steampipe query "SQL"`) or PostgreSQL protocol (pg Pool to port 9193).
(Steampipe는 CLI(`steampipe query "SQL"`) 또는 PostgreSQL 프로토콜(pg Pool, 포트 9193)을 통해 접근할 수 있습니다.)

## Decision / 결정
Use pg Pool direct connection instead of CLI.
(CLI 대신 pg Pool 직접 연결을 사용합니다.)

## Reason / 이유
- CLI: ~4 seconds per query (process spawn overhead, shell escaping issues)
  (CLI: 쿼리당 약 4초 소요 — 프로세스 생성 오버헤드, 셸 이스케이프 문제)
- pg Pool: ~0.006 seconds per query (660x faster)
  (pg Pool: 쿼리당 약 0.006초 — 660배 빠름)
- CLI has shell injection risks with `$` characters in SQL (K8s jsonb queries)
  (CLI는 SQL 내 `$` 문자로 인한 셸 인젝션 위험이 있음 — K8s jsonb 쿼리)
- pg Pool allows connection pooling (max:3) and statement timeouts (120s)
  (pg Pool은 커넥션 풀링(최대 3개) 및 구문 타임아웃(120초)을 지원합니다)

## Consequences / 결과
- Steampipe must run as service: `steampipe service start --database-port 9193`
  (Steampipe를 서비스로 실행해야 합니다: `steampipe service start --database-port 9193`)
- Password sync needed: `scripts/02-setup-nextjs.sh` auto-syncs password to `steampipe.ts`
  (비밀번호 동기화 필요: `scripts/02-setup-nextjs.sh`가 비밀번호를 `steampipe.ts`에 자동 동기화)
- No separate PostgreSQL installation needed (Steampipe embeds PostgreSQL)
  (별도의 PostgreSQL 설치가 필요하지 않습니다 — Steampipe가 PostgreSQL을 내장하고 있음)
