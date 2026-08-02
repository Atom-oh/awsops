# 라이브러리 모듈 / Library Module

## 역할 / Role
API 라우트와 컴포넌트가 공유하는 도메인 로직 102개 모듈 (React 비의존 위주). 테스트는 vitest로 소스 옆 colocate.
(102 domain-logic modules shared by API routes and components, mostly React-free. Tests colocated, vitest.)

## 주요 파일 / Key Files
- `db.ts` — Aurora node-pg 공유 풀 `getPool()`: RDS IAM DB 인증(`awsops_web` 역할, master secret 아님). `password`를 함수로 전달해 커넥션마다 15분 토큰을 새로 서명 — 7일 secret 자동회전에 안전. `max: 3` (shared pool; IAM DB auth, per-connection fresh token)
- `auth.ts` — `verifyUser()`: `awsops_token` 쿠키 RS256 JWKS 재검증, alg 핀 + `token_use==='id'` (cookie re-verification)
- `nfm.ts` / `dns-logs.ts` / `ip-inventory.ts` — 라이브 AWS 쿼리 계층 공통 패턴: **TTL 4분 캐시 + in-flight promise dedupe** (동일 키 동시 요청은 실행 중 promise 공유). 리소스 부재 시 available:false / 온보딩 안내로 degrade (TTL cache + in-flight dedupe; honest degrade when the source is absent)
- `i18n.ts` — `SUPPORTED_LANGS = ['ko','en','zh','ja']`가 single source of truth. 컴파일이 못 잡는 수동 lockstep 3곳: `agent/agent.py` 언어 지시문 맵, `bedrock-direct.ts` lang ternary, `components/inventory/metrics/guides.<lang>.tsx` (hand-maintained lockstep sites)
- `i18n-terms.ts` — `tt(label)`: 한국어 리터럴이 source 문자열, 미등록 문자열은 그대로 통과 (zero-risk fallback). 파라미터 패턴은 RULES 경유
- `eks-incluster.ts` — K8s API 직접 호출 (`aws eks get-token` 재현, P1e Access Entry + AdminViewPolicy). **read-only 불변식: GET만, write verb 절대 발행 금지.** 요청당 4s 타임아웃, AssumeRole 50분 캐시 (read-only invariant: GET only, never a write verb)
- `inventory-types.ts` — 인벤토리 타입 레지스트리(`InvType` spec — DetailPanel `sections`의 근거) (inventory type registry)
- `jobs.ts` — 워커 잡 생성/조회 (`worker_jobs` + SQS enqueue)
- `ssrf-guard.ts` — 외부 datasource 호출 SSRF 방어 (SSRF guard for external calls)

## 규칙 / Rules
- 새 라이브 AWS 쿼리 계층은 `nfm.ts`의 TTL 캐시 + in-flight dedupe 패턴을 복제한다.
- 언어 추가/변경은 `SUPPORTED_LANGS`부터 — TS 소비처는 컴파일로 깨지지만, 위 lockstep 3곳은 수동 갱신 필수.
- DB 접근은 반드시 `getPool()` 경유 — 풀 신규 생성·master secret 사용 금지.
