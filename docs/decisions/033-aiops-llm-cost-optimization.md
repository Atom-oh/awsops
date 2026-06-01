# ADR-033: AIOps LLM Cost Optimization / AIOps LLM 비용 최적화

## Status / 상태

Proposed (2026-06-01) / 제안 (2026-06-01)

This ADR records the *economic* control layer for AWSops' own Bedrock usage. It **extends ADR-016** (model selection strategy), which assigned models per flow and already *anticipated* prompt caching ("prompt-caching friendly", "caching gives a disproportionate win") but never implemented it. ADR-033 turns that anticipation into a concrete, phased cost-optimization decision.

본 ADR은 AWSops 자체 Bedrock 사용의 *경제성* 통제 계층을 기록한다. 경로별 모델을 배정하고 프롬프트 캐싱을 *예고*("prompt-caching friendly", "캐싱이 불균형적 이득")했으나 구현하지 않은 **ADR-016(모델 선택 전략)을 확장**한다. ADR-033은 그 예고를 구체적·단계적 비용 최적화 결정으로 전환한다.

## Context / 컨텍스트

The AIOps LLM spend is AWSops' fastest-growing variable cost: every assistant question pays for an intent classification call plus 1–3 gateway calls plus (for multi-route) a synthesis call (ADR-025), and every alert pays a diagnosis call (ADR-009/032). A code audit (`src/app/api/ai/route.ts`, `src/lib/alert-diagnosis.ts`, `src/app/api/bedrock-metrics/route.ts`) confirms three concrete, recoverable inefficiencies:

AIOps의 LLM 지출은 AWSops에서 가장 빠르게 증가하는 변동비다: 어시스턴트 질문마다 의도 분류 호출 + 1~3개 게이트웨이 호출 + (멀티 라우트 시) 합성 호출(ADR-025)이 발생하고, 알림마다 진단 호출(ADR-009/032)이 발생한다. 코드 감사(`src/app/api/ai/route.ts`, `src/lib/alert-diagnosis.ts`, `src/app/api/bedrock-metrics/route.ts`) 결과 회수 가능한 비효율 3가지가 확인됐다:

1. **Classification runs on Sonnet 4.6 for every question** (`classifyIntent`, `max_tokens: 100`), even for trivially keyword-matchable intents. Haiku 4.5 is selectable by users but the router default never uses it. / **분류가 모든 질문에서 Sonnet 4.6로 실행**된다(`classifyIntent`, `max_tokens: 100`). 키워드로 자명하게 매칭되는 의도조차 그렇다. Haiku 4.5는 사용자 선택은 가능하나 라우터 기본값은 절대 사용하지 않는다.
2. **Bedrock prompt caching is not applied in any call.** The `bedrock` dashboard page only *displays* CloudWatch `CacheReadInputTokenCount` metrics; no `cachePoint`/`cache_control` exists in `callBedrock`, the report pipeline, or alert diagnosis — despite large, invariant prefixes (classifier registry prompt, the 15-section Well-Architected and CIS-431 system prompts, MCP tool schemas). / **어떤 호출에도 Bedrock 프롬프트 캐싱이 적용돼 있지 않다.** `bedrock` 페이지는 CloudWatch `CacheReadInputTokenCount` 지표를 *표시*만 할 뿐, `callBedrock`·리포트 파이프라인·알림 진단에 `cachePoint`/`cache_control`이 없다 — 분류기 레지스트리 프롬프트, 15섹션 Well-Architected·CIS-431 시스템 프롬프트, MCP 도구 스키마처럼 크고 불변인 prefix가 있음에도.
3. **No AI-answer cache and no spend guardrail.** `node-cache` caches only Steampipe query results (5-min TTL) and the cost-availability probe; identical/near-identical NL questions re-invoke Bedrock fully. Token usage is tracked (`agentcore-stats`) but there is no per-tenant/user budget. / **AI 응답 캐시도 지출 가드레일도 없다.** `node-cache`는 Steampipe 결과(5분 TTL)와 Cost 가용성 probe만 캐싱하며, 동일·유사 자연어 질문은 Bedrock을 전부 재호출한다. 토큰 사용량은 추적(`agentcore-stats`)되나 테넌트/사용자별 예산은 없다.

This decision was cross-reviewed by two independent assistants (codex, gemini; kiro-cli did not consume the piped context this round). Both converged on: do the *stateless, in-process* wins now (Haiku-first classification, Bedrock prompt caching) and **defer semantic response caching to the v2 Aurora layer** (ADR-030) so durable tenant isolation and invalidation can be enforced rather than bolted onto single-EC2 node-cache.

본 결정은 두 독립 어시스턴트(codex, gemini; kiro-cli는 이번 회차에 파이프 컨텍스트를 받지 못함)의 교차 검토를 받았다. 둘 다 다음에 수렴했다: *무상태·인프로세스* 이득(Haiku-우선 분류, Bedrock 프롬프트 캐싱)은 지금, **의미 기반 응답 캐싱은 v2 Aurora 계층(ADR-030)으로 연기** — 단일 EC2 node-cache에 억지로 얹는 대신 내구성 있는 테넌트 격리·무효화를 강제할 수 있도록.

## Options Considered / 고려한 대안

### Option 1: Phased cost layer extending ADR-016 — chosen / ADR-016을 확장하는 단계적 비용 계층 — 채택

Phase 1 (v1, in-process, no new infrastructure): heuristic/registry-derived keyword pre-filter → Haiku 4.5 classifier fallback → Sonnet only when ambiguous; Bedrock prompt caching on invariant prefixes; **exact-match** answer cache keyed by `(accountId, userSub, route, normalizedQuestion, sourceDataFingerprint)` with TTL ≤ the Steampipe 5-min window and invalidation on write events; per-tenant/user token budgets via `agentcore-stats` (warn 80%, soft cap, on-call override); confidence-based tiering (Haiku simple / Sonnet normal / Opus deep|low-confidence) and synthesis-skip for a single high-confidence route. Phase 2 (v2, Aurora ADR-030): **semantic** answer cache via Aurora `pgvector`, durable per-tenant budget/cache state, multi-runtime-safe.

Phase 1(v1, 인프로세스, 신규 인프라 없음): 휴리스틱/레지스트리 파생 키워드 pre-filter → Haiku 4.5 분류 폴백 → 애매할 때만 Sonnet; 불변 prefix에 Bedrock 프롬프트 캐싱; `(accountId, userSub, route, 정규화질문, sourceDataFingerprint)` 키의 **정확 일치** 응답 캐시(TTL ≤ Steampipe 5분, write 이벤트 시 무효화); `agentcore-stats` 기반 테넌트/사용자별 토큰 예산(80% 경고, 소프트 캡, 온콜 override); 신뢰도 기반 계단식(단순 Haiku / 일반 Sonnet / 심층·저신뢰 Opus) 및 단일 고신뢰 라우트의 합성 스킵. Phase 2(v2, Aurora ADR-030): Aurora `pgvector` 기반 **의미** 응답 캐시, 내구성 테넌트별 예산/캐시 상태, 멀티 런타임 안전.

- **Pros / 장점**: Phase 1 is software-only on the existing single EC2 — no new AWS services, no write permissions. Prompt caching + Haiku classification cut marginal cost immediately on the highest-QPS paths; the exact answer cache compounds the existing Steampipe cache; budgets bound worst-case spend. Deferring semantic caching avoids correctness/isolation hazards until Aurora can enforce them. Reuses ADR-016's model IDs and the registry-driven classifier. / Phase 1은 기존 단일 EC2에서 소프트웨어만으로 — 신규 AWS 서비스·write 권한 불필요. 프롬프트 캐싱 + Haiku 분류는 최고 QPS 경로에서 즉시 한계비용을 절감하고, 정확 응답 캐시는 기존 Steampipe 캐시와 복리로 작용하며, 예산이 최악 지출을 제한한다. 의미 캐싱 연기는 Aurora가 강제할 수 있을 때까지 정확성·격리 위험을 회피한다. ADR-016 모델 ID와 레지스트리 기반 분류기를 재사용한다.
- **Cons / 단점**: Adds state (caches, budgets), versioning, and invalidation paths; Haiku classification and cached answers introduce a quality-regression surface that needs golden-question regression tests and per-route/model telemetry; two phases mean the largest dedup win (semantic cache) waits for v2. / 상태(캐시·예산)·버저닝·무효화 경로가 추가된다. Haiku 분류와 캐시 응답은 품질 회귀 표면을 만들어 golden-question 회귀 테스트와 라우트/모델별 텔레메트리가 필요하다. 2단계 구성이라 가장 큰 dedup 이득(의미 캐시)은 v2를 기다린다.

### Option 2: Status quo — rejected / 현 상태 — 기각

Keep always-Sonnet classification, no caching, no budgets. / 항상-Sonnet 분류 유지, 캐싱·예산 없음.

- **Pros / 장점**: Zero work; no quality or staleness risk. / 작업 0; 품질·staleness 위험 없음.
- **Cons / 단점**: AIOps cost scales linearly with usage; multi-route synthesis stays token-heavy; no guardrail against a looping agent or a verbose tenant; the system never learns from repeated questions. / AIOps 비용이 사용량에 선형 증가; 멀티 라우트 합성은 토큰 과다 유지; 루핑 에이전트·장황 테넌트에 대한 가드레일 없음; 반복 질문 학습 불가.

### Option 3: Full semantic response cache now on single-EC2 (in-process embeddings) — rejected / 단일 EC2에서 의미 응답 캐시 즉시 도입(인프로세스 임베딩) — 기각

Embed every question and serve near-duplicates from an in-process vector index on the EC2 host. / 모든 질문을 임베딩해 EC2 호스트의 인프로세스 벡터 인덱스에서 유사 질문을 응답.

- **Pros / 장점**: Largest immediate Bedrock-call elimination (40–60% on repeated ops queries). / 가장 큰 즉시 Bedrock 호출 제거(반복 운영 질문 40~60%).
- **Cons / 단점**: Highest correctness risk — a semantic hit can return a plausible-but-wrong answer about live infrastructure; per-tenant isolation and invalidation are hard to guarantee in volatile EC2 memory and are lost on restart; couples a high-stakes feature to a substrate (single-EC2) being replaced by v2 Aurora. Better built once on `pgvector`. / 정확성 위험 최대 — 의미 히트가 라이브 인프라에 대해 그럴듯하지만 틀린 답을 반환할 수 있고, 휘발성 EC2 메모리에서 테넌트 격리·무효화 보장이 어렵고 재시작 시 소실된다. 고위험 기능을 v2 Aurora로 대체될 substrate(단일 EC2)에 결합한다. `pgvector`에서 한 번에 구축하는 편이 낫다.

### Option 4: Rely solely on AWS Bedrock intelligent prompt routing — rejected / AWS Bedrock intelligent prompt routing에만 의존 — 기각

Replace the custom classifier-driven model selection with Bedrock's managed in-family prompt router. / 커스텀 분류기 기반 모델 선택을 Bedrock 관리형 in-family prompt router로 대체.

- **Pros / 장점**: Managed, less code; routes within a model family automatically. / 관리형, 코드 감소; 모델 패밀리 내 자동 라우팅.
- **Cons / 단점**: In-family only and opaque — does not address classification cost, prompt caching, answer caching, or per-tenant budgets, and surrenders the registry-driven, observable routing AWSops depends on. Usable as an *optional* augmentation inside Option 1, not a replacement. / in-family 한정·불투명 — 분류 비용·프롬프트 캐싱·응답 캐싱·테넌트 예산을 다루지 못하고, AWSops가 의존하는 레지스트리 기반·관측 가능 라우팅을 포기한다. Option 1 내부의 *선택적* 보강으로는 사용 가능하나 대체는 아니다.

## Decision / 결정

Adopt **Option 1**. Relationships:

**Option 1**을 채택한다. 관계:

| Relationship | ADR | Meaning |
|---|---|---|
| **extends** | ADR-016 | Implements the prompt-caching and tiering ADR-016 anticipated; keeps its `MODELS` IDs and depth-vs-latency assignments, adds Haiku-first classification + caching + budgets on top. |
| **extends** | ADR-025 | Multi-route parallel synthesis gains confidence-based synthesis-skip and cached-prefix synthesis. |
| **extends** | ADR-017 | Answer/exact cache reuses the `node-cache` + cache-warmer patterns and the accountId-prefixed key convention; TTL bounded by the Steampipe cache window. |
| **relates** | ADR-030 | Phase 2 semantic cache + durable budget state live in the v2 Aurora layer (`pgvector`); Phase 1 stays in-process. |
| **relates** | ADR-018 / ADR-008 | All caches and budgets are partitioned per account + per user (`userSub`); no cross-tenant retrieval, ever. |
| **relates** | ADR-033 consumers | ADR-034 (alert auto-RCA write-back) reuses this caching + severity gating to bound alert-storm token cost. |

Mutating nothing in customer infrastructure, ADR-033 is **not** gated by ADR-029.

고객 인프라를 변경하지 않으므로 ADR-033은 ADR-029 게이트 대상이 **아니다**.

## Consequences / 영향

### Positive / 긍정적
- Marginal Bedrock cost drops on the highest-QPS paths (classification, multi-route synthesis, repeated questions) with no new infrastructure in Phase 1. / Phase 1에서 신규 인프라 없이 최고 QPS 경로(분류·멀티 라우트 합성·반복 질문)의 한계 Bedrock 비용이 감소한다.
- Prompt caching also lowers first-token latency on cached prefixes — a UX win, not only cost. / 프롬프트 캐싱은 캐시된 prefix의 첫 토큰 지연도 낮춘다 — 비용뿐 아니라 UX 이득.
- Per-tenant budgets give operators a hard ceiling against runaway agents and noisy tenants. / 테넌트별 예산은 루핑 에이전트·소란 테넌트에 대한 강한 상한을 제공한다.

### Negative / 부정적
- New invalidation logic (write events, registry/prompt-version changes, Steampipe schema changes) is a bug surface; a stale answer cache can hide live infra state. Mitigation: TTL ≤ Steampipe window, source-data fingerprint in the key, exact-match only in v1. / 새 무효화 로직(write 이벤트, 레지스트리/프롬프트 버전, Steampipe 스키마 변경)은 버그 표면이며, 오래된 응답 캐시는 라이브 상태를 숨길 수 있다. 완화: TTL ≤ Steampipe 윈도, 키에 source-data fingerprint, v1은 정확 일치만.
- Haiku classification/cached answers may degrade nuance on cross-account/cross-service questions. Mitigation: confidence thresholds with Sonnet/Opus fallback, golden-question regression tests, telemetry by model/route/tenant. / Haiku 분류·캐시 응답은 교차 계정·서비스 질문의 뉘앙스를 떨어뜨릴 수 있다. 완화: 신뢰도 임계 + Sonnet/Opus 폴백, golden-question 회귀 테스트, 모델/라우트/테넌트별 텔레메트리.
- Token budgets can block a legitimate deep investigation mid-incident. Mitigation: explicit on-call override with audit trail. / 토큰 예산이 인시던트 중 정당한 심층 조사를 막을 수 있다. 완화: 감사 추적이 있는 명시적 온콜 override.

### Post-acceptance deviations / 채택 후 편차
- None yet (Proposed). / 아직 없음 (제안 상태).

## References / 참고 자료
- ADR-016 (Bedrock model selection), ADR-025 (multi-route synthesis), ADR-017 (cache warmer), ADR-030 (ECS/Aurora split), ADR-018 (memory isolation), ADR-008 (multi-account)
- Amazon Bedrock prompt caching — https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- Amazon Bedrock intelligent prompt routing — https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html
- Co-authored via `/co-agent` ADR mode; alternatives/risks cross-reviewed by codex and gemini (kiro-cli unavailable this round); Claude as chair.
