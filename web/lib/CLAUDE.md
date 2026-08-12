# 라이브러리 모듈 / Library Module

## 역할 / Role
API 라우트와 컴포넌트가 공유하는 도메인 로직 116개 모듈 (React 비의존 위주, `collectors/` 포함). 테스트는 vitest로 소스 옆 colocate.
(116 domain-logic modules shared by API routes and components, mostly React-free. Tests colocated, vitest.)

## 주요 파일 / Key Files
- `db.ts` — Aurora node-pg 공유 풀 `getPool()`: RDS IAM DB 인증(`awsops_web` 역할, master secret 아님). `password`를 함수로 전달해 커넥션마다 15분 토큰을 새로 서명 — 7일 secret 자동회전에 안전. `max: 3` (shared pool; IAM DB auth, per-connection fresh token)
- `auth.ts` — `verifyUser()`: `awsops_token` 쿠키 RS256 JWKS 재검증, alg 핀 + `token_use==='id'` (cookie re-verification)
- `aws-data.ts` — 챗 'aws-data' 라우트의 Steampipe SQL 계층: LLM SELECT 생성(자기교정 1회) → 라이브 실행(SELECT-only 가드, 200행 캡, 전용 소형 풀 `max: 2` + `statement_timeout: 35s` — 콜드 멀티 리전 와이드 스캔 실측 상향) → 행 기반 Bedrock 분석 스트림. **sonnet-5 응답은 thinking 블록으로 시작할 수 있음 — `content[0].text` 가정 금지, 텍스트 블록 전부 읽기.** 이력의 ⚠️ 시작 assistant 폴백 턴은 SQL 생성 컨텍스트에서 제외 — 모델이 "도구 불가"로 오도되는 이력 오염 방어 (LLM-generated Steampipe SQL over a guarded dedicated pool; never assume content[0] is the text block; filter ⚠️ fallback turns out of history)
- `collectors/` — auto-collect 콜렉터 6종 레지스트리 (idle-scan, eks/db/msk-optimize, trace-analyze, incident). `COLLECTORS`에 등록 한 줄이면 챗 라우트가 추가된다 — chat/route.ts는 `collectorByKey` 단일 generic 분기 (registry-driven: one entry adds a chat route)
- `nfm.ts` / `dns-logs.ts` / `ip-inventory.ts` / `tgw.ts` / `vpce.ts` / `dx.ts` / `anfw.ts` — 라이브 AWS 쿼리 계층 공통 패턴: **TTL 4분 캐시 + in-flight promise dedupe** (동일 키 동시 요청은 실행 중 promise 공유). 리소스 부재 시 available:false / 온보딩 안내로 degrade (TTL cache + in-flight dedupe; honest degrade when the source is absent)
- 파일별 함정 (per-file traps): `nfm.ts` 라이브 조회 상한 1h (`NFM_MAX_RANGE_SEC` — API ValidationException 실측, 더 긴 기간은 수집 파이프라인 필요) · `dns-logs.ts` Logs Insights `parse` 서버측 집계 — `@message`는 원시 JSON 텍스트라 내부 따옴표가 `\"`로 이스케이프되어 있어 정규식이 이를 매칭해야 함 · `vpce.ts` Interface 엔드포인트 미사용(유휴 과금) 감지 — `AWS/PrivateLinkEndpoints` BytesProcessed 0/시리즈 부재 · `tgw.ts` TGW는 리전 리소스 — 소속 리전별 EC2 클라이언트 필수, 기본 리전만 쓰면 조용히 빈 결과 · `dx.ts` 호스티드(<1G) 커넥션은 커넥션 레벨 Bps 미발행 → VIF 레벨 메트릭 사용, `VirtualInterfaceUtilization*`은 퍼센트 발행(실측 검증), VIF 응답의 `authKey`/`customerRouterConfig`는 민감정보 — row에 싣지 않음 · `anfw.ts` AWS/NetworkFirewall 메트릭은 3-dim(AZ,Engine,FirewallName)과 EndpointName 포함 4-dim이 동시 발행 — 3-dim만 채택(합산 시 이중 집계), 수신 패킷/바이트는 Engine=Stateless만 합산(Stateful recv는 SFE 포워딩 재발행이라 이중 집계 — Passed/Dropped/Rejected는 최종 처분 엔진 단일 발행이라 엔진 합산 유지), 룰 그룹 룰 본문(RulesSource)은 응답에 미탑재
- `i18n.ts` — `SUPPORTED_LANGS = ['ko','en','zh','ja']`가 single source of truth. 컴파일이 못 잡는 수동 lockstep 3곳: `agent/agent.py` 언어 지시문 맵, `bedrock-direct.ts` lang ternary, `components/inventory/metrics/guides.<lang>.tsx` (hand-maintained lockstep sites)
- `i18n-terms.ts` — `tt(label)`: 한국어 리터럴이 source 문자열, 미등록 문자열은 그대로 통과 (zero-risk fallback). 파라미터 패턴은 RULES 경유
- `eks-incluster.ts` — K8s API 직접 호출 (`aws eks get-token` 재현, P1e Access Entry + AdminViewPolicy). **read-only 불변식: GET만, write verb 절대 발행 금지.** 요청당 4s 타임아웃, AssumeRole 50분 캐시 (read-only invariant: GET only, never a write verb)
- `inventory-types.ts` — 인벤토리 타입 레지스트리(`InvType` spec — DetailPanel `sections`의 근거) (inventory type registry)
- `jobs.ts` — 워커 잡 생성/조회 (`worker_jobs` + SQS enqueue)
- `changelog.ts` — 사이드바 버전 칩 + 변경 이력 모달의 데이터 계층 (서버 전용, fs). **단일 진실 = repo 루트 `CHANGELOG.md`** — deploy.mjs가 빌드 직전 이미지로 복사(`/app/CHANGELOG.md`), 로컬 dev는 `../CHANGELOG.md` 폴백. 이중언어(# English / # 한국어) (the root CHANGELOG.md file is the single source of truth)
- `ssrf-guard.ts` — 외부 datasource 호출 SSRF 방어 (SSRF guard for external calls)

## 규칙 / Rules
- 새 라이브 AWS 쿼리 계층은 `nfm.ts`의 TTL 캐시 + in-flight dedupe 패턴을 복제한다.
- 언어 추가/변경은 `SUPPORTED_LANGS`부터 — TS 소비처는 컴파일로 깨지지만, 위 lockstep 3곳은 수동 갱신 필수.
- DB 접근은 반드시 `getPool()` 경유 — 풀 신규 생성·master secret 사용 금지.
