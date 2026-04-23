# ADR-001: Steampipe pg Pool과 CLI 비교 / Steampipe pg Pool over CLI

## 상태: 승인됨 / Status: Accepted

## 컨텍스트 / Context
Steampipe는 CLI(`steampipe query "SQL"`) 또는 PostgreSQL 프로토콜(pg Pool, 포트 9193)을 통해 접근할 수 있습니다.
(Steampipe can be accessed via CLI (`steampipe query "SQL"`) or PostgreSQL protocol (pg Pool to port 9193).)

## 결정 / Decision
CLI 대신 pg Pool 직접 연결을 사용합니다.
(Use pg Pool direct connection instead of CLI.)

## 이유 / Reason
- CLI: 쿼리당 약 4초 소요 — 프로세스 생성 오버헤드, 셸 이스케이프 문제
  (CLI: ~4 seconds per query — process spawn overhead, shell escaping issues)
- pg Pool: 쿼리당 약 0.006초 — 660배 빠름
  (pg Pool: ~0.006 seconds per query — 660x faster)
- CLI는 SQL 내 `$` 문자로 인한 셸 인젝션 위험이 있음 — K8s jsonb 쿼리
  (CLI has shell injection risks with `$` characters in SQL — K8s jsonb queries)
- pg Pool은 커넥션 풀링(최대 10개) 및 구문 타임아웃(120초)을 지원합니다. 배치 쿼리는 8개씩 순차 실행, 캐시는 node-cache (TTL 300초, 계정별 접두사 키). 상세 튜닝 근거는 ADR-017 참고.
  (pg Pool allows connection pooling (max:10) and statement timeouts (120s). Batch queries run 8 sequentially; cache is node-cache (TTL 300s, accountId-prefixed keys). See ADR-017 for tuning rationale.)

## 결과 / Consequences
- Steampipe를 서비스로 실행해야 합니다: `steampipe service start --database-port 9193`
  (Steampipe must run as service: `steampipe service start --database-port 9193`)
- 비밀번호 동기화 필요: `scripts/02-setup-nextjs.sh`가 비밀번호를 `steampipe.ts`에 자동 동기화
  (Password sync needed: `scripts/02-setup-nextjs.sh` auto-syncs password to `steampipe.ts`)
- 별도의 PostgreSQL 설치가 필요하지 않습니다 — Steampipe가 PostgreSQL을 내장하고 있음
  (No separate PostgreSQL installation needed — Steampipe embeds PostgreSQL)
