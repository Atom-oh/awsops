# ADR-038: Hybrid Agent Routing (Regex Fast-Path + Haiku Classifier) + v2 Prompt Caching / 하이브리드 에이전트 라우팅 (정규식 fast-path + Haiku 분류기) + v2 프롬프트 캐싱

## Status / 상태

Accepted (2026-06-10) / 채택 (2026-06-10) — 멀티AI 의사결정(Kiro·Codex·Gemini **만장일치 A-now / C-at-P4**) + 멀티AI 스펙 리뷰(Verdict REVIEW → 8건 전부 반영, 그중 2건은 코드 검증 결함). 설계 스펙: `docs/superpowers/specs/2026-06-10-hybrid-agent-routing-design.md`.

This ADR records the v2 chat **routing accuracy** decision and extends **ADR-033**'s prompt-caching decision into the v2 call path. It also records an explicit **deferral**: AgentCore Gateway semantic tool search is adopted at **P4**, not now.

본 ADR은 v2 챗 **라우팅 정확도** 결정을 기록하고, **ADR-033**의 프롬프트 캐싱 결정을 v2 호출 경로로 확장한다. 또한 명시적 **연기 결정** — AgentCore Gateway 시맨틱 툴 검색은 지금이 아닌 **P4**에서 채택 — 을 기록한다.

## Context / 컨텍스트

`.reference` AIOps 자료(AWS DBA AIOps 사례·삼성 DB-Ops 워크샵·DBA Strands+AgentCore 덱) 검토와 코드 대조에서 v2 챗 파이프라인의 라우팅이 가장 큰 정확도 갭으로 확인됐다:

- `web/lib/route.ts`의 `pickGateway`는 9개 섹션에 대한 **first-match 키워드 정규식**. 다중도메인 질의("EKS 파드가 RDS 연결 안 돼")는 첫 매칭(container)으로 빠져 실제 원인(network/data)을 놓치고, 무매칭 질의는 `ops`로 강등되는데 **`ops`는 비활성**(`sections.ts` `active:false`)이다.
- 9개 게이트웨이 중 **2개만 라이브**(security ~14툴, network 1툴). 전체 함대는 P3.
- `chat/route.ts:39`의 `pickCustomAgent(prompt, customAgents) ?? gateway`(ADR-031)가 이미 게이트웨이를 오버라이드하지만, 라우팅 우선순위가 어디에도 정의돼 있지 않다.
- `agent.py`의 Strands `BedrockModel`에는 프롬프트 캐싱·temperature가 없다. ADR-033은 캐싱을 결정했으나 v1 게이트웨이 호출이 불투명해 적용 범위를 정정했었다 — v2의 `BedrockModel`은 우리가 직접 제어하는 Bedrock 호출 지점이다.

The reference materials' "300 tools → semantic search injects only ~4" pattern (AgentCore Gateway `searchType=SEMANTIC`) is the platform-native end-state, but its payoff is tied to a full gateway fleet that does not exist yet.

## Options Considered / 고려한 대안

### Option A: Hybrid — regex fast-path + Haiku classifier fallback — **chosen / 채택**
- **Pros**: 명확한 질의(~70%)는 기존 정규식이 즉시·무료 처리; 모호/무매칭만 Haiku가 top-3 랭킹; 단일-게이트웨이/턴 + 섹션별 `SKILL_BASE` 전문가 프롬프트 + 기존 테스트 유지; 지금 출하 가능; 오라우팅 로그가 P4 시맨틱 설계의 입력이 됨.
- **Cons**: 코드 경로 2개; 모호 질의에 ~0.5–0.9s 지연; BFF에 Bedrock Runtime IAM 신규 의존.

### Option B: Embedding classifier — rejected / 임베딩 분류기 — 기각
- **Pros**: 쿼리당 매우 저렴·결정적·빠름.
- **Cons**: 임베딩 저장/갱신 인프라 신규; 추론형 중의성 해소(다중도메인 원인 추정)는 LLM보다 약함.

### Option C: AgentCore Gateway semantic tool search now — **deferred to P4 / P4로 연기** (패널 만장일치)
- **Pros**: 플랫폼 네이티브; BFF 휴리스틱 제거; 교차-게이트웨이로 자연 확장.
- **Cons (지금)**: ① 9중 2개만 라이브 — 교차-게이트웨이 라우팅 결정이 지금은 발생 불가(Kiro); ② 단일 통합 에이전트가 섹션별 `SKILL_BASE` 페르소나를 희석/붕괴(Kiro·Gemini); ③ 비어있는 게이트웨이에 시맨틱 검색 → 무관 질의 유령매칭(Gemini); ④ 게이트웨이당 ~20툴 — 시맨틱 인덱싱은 50+툴 전엔 과잉(Gemini); ⑤ 튜닝 사이클이 Terraform 재프로비전에 묶임. **P4 인시던트 오케스트레이터에서 전 함대 + 본 ADR의 오라우팅 데이터로 채택.**

### Option 0: Status quo (regex only) — rejected / 현상 유지 — 기각
- 다중도메인 오라우팅과 비활성 `ops` 폴백이 P3 챗 UX의 신뢰를 깎는다.

## Decision / 결정

스펙(`2026-06-10-hybrid-agent-routing-design.md`)대로 구현한다. 핵심:

1. **`classifyRoute(prompt, pinned)`** (web/lib/route.ts + 신규 web/lib/classifier.ts): pin → 정규식(distinct 1개 섹션 매칭 시) → Haiku 분류기(9섹션 top-3 + 신뢰도) → 실패 시 **활성 섹션 폴백**(비활성 `ops` 금지, 챗 비차단).
2. **라우팅 우선순위 명문화**: `explicit pin > custom agent(ADR-031) > classifier(regex>llm) > 활성 폴백`. 전환칩(pin 재전송)이 커스텀 매칭보다 우선.
3. **Top-1 자동 라우팅 + 2·3위 전환칩**; top-1이 비활성 섹션이면 에이전트 미호출 + "P3 예정" 정직 안내 + 활성 대안 칩(유령매칭 0).
4. **meta SSE 이벤트는 모든 경로에서 항상 방출**(heartbeat 직후, `{gateway, ranked, method, customAgent?}`).
5. **분류기 보안**: 불변 시스템 프롬프트 + `<query>` 구분자 + 엄격 enum/스키마 검증 + 툴 없음 + advisory-only(권한 결정 불사용).
6. **프롬프트 캐싱 + temperature=0** (agent.py): **선행 스파이크가 전제조건** — `strands-agents` 버전 핀 + `BedrockModel` 캐시 파라미터 실측 + 기동 스모크. 미지원이면 graceful no-op, temperature만 적용. ADR-033 토큰 기록으로 절감 검증.
7. **게이트**: `hybrid_routing_enabled` flag(기본 false) + 골든셋 정확도 **≥85% 그리고 regex 대비 +15pp** 충족 시 활성화. 오라우팅(llm 라우팅 후 칩 전환) 로그 적재 → P4 입력.
8. **IAM**: web task role에 `bedrock:InvokeModel`(Haiku foundation-model/inference-profile ARN 한정), `@aws-sdk/client-bedrock-runtime`, 타임아웃 1s(실제 abort) + 429 백오프 1회.

## Consequences / 영향

### Positive / 긍정적
- 다중도메인·무매칭 질의의 라우팅 정확도 상승을 골든셋으로 정량 검증; 비활성 섹션 유령매칭 제거.
- 라우팅 우선순위가 처음으로 명문화되어 ADR-031 커스텀 에이전트와의 상호작용이 결정적.
- v2 직접 호출 경로에 캐싱이 실리면 반복 질의 입력 토큰 대폭 절감(ADR-033 기록으로 검증) + temperature=0으로 툴선택 결정성.
- 오라우팅 로그가 P4 시맨틱 라우팅의 학습 데이터가 됨.

### Negative / 부정적
- 모호 질의에 분류기 지연(~0.5–0.9s, abort 상한 1s).
- BFF가 Bedrock Runtime을 직접 호출하는 신규 IAM 표면(Haiku ARN 한정으로 최소화).
- 캐싱 절감은 Strands 스파이크 결과에 조건부 — 미지원이면 이 ADR의 캐싱 절반은 temperature=0만 남음.
- 분류기는 프롬프트 인젝션 표면(최악 = 오라우팅, 권한 영향 없음 — enum 검증으로 완화).

### Post-acceptance deviations / 채택 후 편차
- **2026-06-10 (구현 계획 적대적 검증 라운드, 3-렌즈 워크플로):**
  - **캐싱 검증 방법 대체** — 스펙은 "ADR-033 토큰 기록으로 절감 검증"이라 했으나 ADR-033 기록 코드는 v1(`src/`) 전용으로 v2 `web/`에 부재. 검증은 **CloudWatch Logs의 usage(`cacheReadInputTokens`)**로 대체한다.
  - **분류기 모델 ID 실측 확정** — `apac.` Haiku 4.5 inference profile은 존재하지 않음. 실측 ID = `global.anthropic.claude-haiku-4-5-20251001-v1:0` (ap-northeast-2 Converse 실호출 성공, 액세스 활성).
  - **캐싱 파라미터 스파이크 완료** — `strands-agents==1.41.0`(핀)의 `BedrockConfig`가 `cache_config: CacheConfig(strategy="auto")` + `cache_tools="default"` + `temperature` 공식 지원 확인(소스 실측). `cache_prompt`는 deprecated라 미사용. 미지원 버전 대비 try/except graceful no-op 가드 포함.
  - **오라우팅 적재 메커니즘 확정** — Aurora 테이블 대신 `switchedFrom` 필드 + 구조화 `console.warn` → CloudWatch Logs (P4 시맨틱 라우팅 코퍼스 용도로 충분).
  - **골든셋 게이트 수학 보정** — 초안 52케이스의 regex 베이스라인이 82.7%로 +15pp 게이트를 달성 불가로 만들어, 무매칭 13케이스를 추가(65케이스). 게이트 수치(≥85% AND +15pp)는 불변 — 바인딩은 85% SLO(이산 65케이스라 유효 바는 56/65 ≈ 86.2%).
- **2026-06-10 (구현 완료, 최종 크로스태스크 리뷰 READY):**
  - **최종 regex 베이스라인 = 69.2% (45/65)** — 리뷰 라운드의 라벨 와이드닝 2건("백업"→data·ops, "디스크"→monitoring·observability) 반영 후. 초안 트레이스(67.7%)에서 +1케이스.
  - **⚠️ P3 전제조건 (load-bearing invariant)** — `agent/agent.py` `SKILL_BASE`에는 `observability` 키가 없고(`diagnostics`가 별도 존재), 미지 키는 `ops` 페르소나로 폴백한다. 오늘은 `observability`가 `active:false`라 하이브리드 단락이 에이전트 호출 자체를 막아 안전하지만, **P3에서 어떤 섹션이든 `active:true`로 전환하기 전에 해당 키의 `SKILL_BASE` 엔트리 존재를 확인해야 한다**(또는 agent.py에 active-section↔SKILL_BASE 패리티 기동 체크 추가). 위반 시 잘못된 전문가 프롬프트로 무음 라우팅된다.
  - 활성화(계획 Task 8)는 라이브 골든셋 게이트(`scripts/v2/routing-accuracy.mjs`) 통과가 전제 — 통과 수치를 본 섹션에 기록할 것.
- **2026-06-10 (T8 활성화 — LIVE):**
  - **게이트 결과: regex 69.2% → hybrid 96.9% (63/65), +27.7pp — PASSED** (SLO ≥85% 및 +15pp 모두 충족). `hybrid_routing_enabled=true` apply(IAM `task_classifier_bedrock` + env, task-def 리비전 교체) + `make deploy` + `make agentcore`(strands 1.41.0 핀 + 캐싱) 완료.
  - **타임아웃 편차(스펙 §6 정정)**: 스펙의 분류기 abort 1s는 실측과 불일치 — `global.` 크로스리전 프로파일은 ap-northeast-2에서 **1.9~3.0s** 소요(게이트 1차 실행이 hybrid 72.3%로 FAIL한 원인 = 전 호출 abort→폴백). **3500ms로 상향**(`CLASSIFIER_TIMEOUT_MS` env 튜너블) 후 게이트 통과. 모호 질의의 first-byte 지연 상한도 3.5s로 갱신.
  - **캐싱 검증(GREEN)**: agent 동일 세션 2회 호출 11.6s→7.0s; us-east-1 Sonnet 4.6 CloudWatch 30분 창 **CacheReadInputTokenCount 8,714 / CacheWrite 3,096 / uncached Input 5,954** — 입력 ~59% 캐시 히트(읽기 90% 할인) 확인.

## References / 참고 자료
- 설계 스펙: `docs/superpowers/specs/2026-06-10-hybrid-agent-routing-design.md` (멀티AI 리뷰 8건 반영 이력 포함)
- ADR-033 (프롬프트 캐싱 결정·토큰 기록), ADR-031 (커스텀 에이전트 — 우선순위 통합), ADR-016 (모델 선택), ADR-002 (v1 하이브리드 라우팅 전례)
- `.reference/` AWS AIOps 자료 3종 (토큰 효율·시맨틱 툴 검색·safety 패턴의 출처)
- 멀티AI 패널 기록: 의사결정(A/B/C) 및 스펙 리뷰 라운드 — 스펙 §10
