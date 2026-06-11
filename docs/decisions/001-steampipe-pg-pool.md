# ADR-001: Steampipe pg Pool과 CLI 비교 / Steampipe pg Pool over CLI

## 상태: 승인됨 / Status: Accepted

> **v2 note (2026-06-03, corrected 2026-06-10 by ADR-037)**: the core decision (query Steampipe via the **pg Pool, not the CLI**) is a v1 detail. For v2, **ADR-037 is authoritative: there is no live Steampipe** — only a flag-gated inventory-sync batch (`var.steampipe_enabled`, D1) exists. The earlier note that ADR-030 would move Steampipe into an `awsops-steampipe` Fargate task reached via Service Connect DNS (`awsops-steampipe.awsops.local:9193`) was a superseded 030 draft mechanism that was never implemented; v2 live AWS queries go through **AgentCore MCP**. / 핵심 결정(**CLI가 아닌 pg Pool**로 Steampipe 조회)은 v1 세부. v2는 **ADR-037이 확정: 라이브 Steampipe 없음** — flag-gated 인벤토리 sync 배치(`var.steampipe_enabled`, D1)만 존재. ADR-030이 Steampipe를 Service Connect DNS(`awsops-steampipe.awsops.local:9193`) 접근 `awsops-steampipe` Fargate 태스크로 이전한다던 종전 노트는 구현되지 않은 폐기된 030 초안 메커니즘이며, v2 라이브 조회는 **AgentCore MCP** 경유.

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
