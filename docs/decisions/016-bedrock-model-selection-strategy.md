# ADR-016: Bedrock Model Selection Strategy / Bedrock 모델 선택 전략

## Status: Accepted (2026-04-22) / 상태: 채택됨

## Context / 컨텍스트

AWSops invokes Amazon Bedrock from multiple independent code paths: the AI Assistant chat router (`src/app/api/ai/route.ts`), the natural-language-to-query translator for external datasources (`src/app/api/datasources/route.ts`), the 15-section comprehensive diagnosis pipeline (`src/app/api/report/route.ts`), and the alert-triggered root cause orchestrator (`src/lib/alert-diagnosis.ts`). Each path has a different latency budget, concurrency profile, and depth-of-reasoning requirement. Until recently the codebase used ad-hoc model IDs per flow, which led to inconsistencies — alert diagnosis originally called `anthropic.claude-opus-4-6` against `us-east-1`, which both raised cost and added cross-region hop latency.

AWSops는 다수의 독립 경로에서 Amazon Bedrock을 호출한다: AI 어시스턴트 채팅 라우터(`src/app/api/ai/route.ts`), 외부 데이터소스 자연어→쿼리 변환기(`src/app/api/datasources/route.ts`), 15섹션 종합 진단 파이프라인(`src/app/api/report/route.ts`), 알림 트리거 근본 원인 오케스트레이터(`src/lib/alert-diagnosis.ts`). 경로마다 지연 예산·동시성 프로파일·추론 깊이 요구사항이 다르다. 이전에는 경로별로 ad-hoc 모델 ID를 사용하여 일관성이 없었으며, 특히 알림 진단이 `us-east-1`에서 `anthropic.claude-opus-4-6`를 호출해 비용과 크로스 리전 지연이 같이 발생하던 상태였다.

The landing commit `ba03173` ("fix: use global.anthropic.claude-sonnet-4-6 model ID for alert diagnosis") made the switch for the alert pipeline concrete. This ADR documents the broader rule that governs that change and all future Bedrock model choices.

랜딩 커밋 `ba03173`("fix: use global.anthropic.claude-sonnet-4-6 model ID for alert diagnosis")에서 알림 파이프라인의 교체를 구체화했다. 본 ADR은 해당 교체뿐 아니라 향후 모든 Bedrock 모델 선택을 지배하는 상위 규칙을 문서화한다.

## Decision / 결정

Assign Bedrock models to flows by **depth-vs-latency axis**, using only two canonical model IDs with the cross-region inference profile prefix `global.` so the call resolves within the same Bedrock availability boundary:

경로별로 **깊이 대 지연 축(depth-vs-latency axis)**에 따라 Bedrock 모델을 배정한다. 표준 모델 ID는 크로스 리전 추론 프로파일 접두사 `global.`을 포함하여 두 개만 사용하며, Bedrock 가용성 경계 내에서 호출이 해석되도록 한다.

```typescript
// src/app/api/ai/route.ts
const MODELS: Record<string, string> = {
  'sonnet-4.6': 'global.anthropic.claude-sonnet-4-6',
  'opus-4.6':   'global.anthropic.claude-opus-4-6-v1',
};
```

| Flow | File | Model | Rationale |
|------|------|-------|-----------|
| AI Assistant chat (default) | `src/app/api/ai/route.ts` | `global.anthropic.claude-sonnet-4-6` | SSE streaming, interactive latency sensitive |
| Router classifier + tool inference | `src/app/api/ai/route.ts` | `global.anthropic.claude-sonnet-4-6` | Short prompts, high QPS, prompt-caching friendly |
| Datasource NL→query | `src/app/api/datasources/route.ts` | `global.anthropic.claude-sonnet-4-6` | 300-token output cap, sub-second required |
| Alert diagnosis orchestrator | `src/lib/alert-diagnosis.ts` | `global.anthropic.claude-sonnet-4-6` | Burst concurrency, Slack time budget, commit `ba03173` |
| 15-section comprehensive diagnosis | `src/app/api/report/route.ts` | `global.anthropic.claude-opus-4-6-v1` | Multi-minute background job, depth over speed |
| Scheduled full-report runs | `src/lib/report-scheduler.ts` → report route | `global.anthropic.claude-opus-4-6-v1` | Same path as manual report |
| Opt-in Opus in AI chat | `src/app/api/ai/route.ts` (`modelKey: 'opus-4.6'`) | `global.anthropic.claude-opus-4-6-v1` | Power-user override only |

## Rationale / 근거

**Latency-sensitive flows use Sonnet.** Alert diagnosis must deliver a Slack/SNS message within the operator's attention window; AI chat streams SSE tokens where first-token latency is perceptible; the router and the NL→query translator run on every request and must not become the critical path. Sonnet's time-to-first-token is measurably lower than Opus on equivalent prompts, and the quality ceiling is sufficient for these bounded tasks because the surrounding context (collectors, Steampipe rows, prompt templates) already narrows the reasoning space.

지연 민감 경로는 Sonnet 사용. 알림 진단은 운영자의 주의 윈도 안에 Slack/SNS 메시지를 전달해야 하고, AI 채팅은 SSE 토큰 스트리밍에서 첫 토큰 지연이 체감되며, 라우터·NL→쿼리 변환기는 요청마다 실행되므로 크리티컬 경로가 되면 안 된다. 동일 프롬프트에서 Sonnet의 첫 토큰 시간이 Opus보다 측정 가능 수준으로 낮고, 컬렉터·Steampipe 결과·프롬프트 템플릿이 추론 공간을 이미 좁혀주므로 이들 경계적 작업에는 Sonnet 품질 상한이 충분하다.

**Depth-sensitive flows use Opus.** The 15-section diagnosis batches three sections per Bedrock call, runs as a background job, and the output is consumed as a formal report (DOCX/MD/PDF). Here the cost per invocation is amortized across the report lifecycle and the quality delta between Sonnet and Opus is the observable artifact. The same logic applies to the scheduler, which reuses the report route.

깊이 민감 경로는 Opus 사용. 15섹션 진단은 Bedrock 호출당 3개 섹션을 배치하고, 백그라운드 잡으로 실행되며, 결과물은 정식 리포트(DOCX/MD/PDF)로 소비된다. 이 경로에서는 호출당 비용이 리포트 생애주기 전체에 상각되고 Sonnet과 Opus의 품질 차이가 산출물에 직접 드러난다. 스케줄러는 동일 리포트 라우트를 재사용하므로 같은 규칙을 따른다.

**Cost axis.** Per `src/app/api/bedrock-metrics/route.ts` price table, Opus is `$15/1M input` + `$75/1M output` vs Sonnet at `$3/1M input` + `$15/1M output` — roughly 5x. At alert burst scale (tens of incidents per hour in degraded environments) the Opus path would multiply monthly Bedrock spend by 10-50x relative to the Sonnet path.

비용 축. `src/app/api/bedrock-metrics/route.ts` 가격 테이블 기준 Opus는 `$15/1M input` + `$75/1M output`, Sonnet은 `$3/1M input` + `$15/1M output` — 약 5배 차이. 알림 버스트 규모(저하된 환경에서 시간당 수십 인시던트)에서 Opus 경로는 Sonnet 경로 대비 월간 Bedrock 비용을 10-50배로 증폭시킬 수 있다.

**Concurrency axis.** Bedrock throughput quotas for Opus are stricter than Sonnet on shared-capacity modes. Alert storms (correlated incidents, ADR-009) would exhaust the Opus quota first and produce 429s on the most time-critical path. Sonnet's higher throughput headroom keeps the alert pipeline running during exactly the events it was built for.

동시성 축. Bedrock 공유 용량 모드에서 Opus 쿼터는 Sonnet보다 엄격. 알림 스톰(상관 인시던트, ADR-009)이 발생하면 가장 시간 임계적인 경로에서 Opus 쿼터가 먼저 소진되어 429를 유발한다. Sonnet의 처리량 여유는 알림 파이프라인이 설계된 바로 그 상황에서 동작을 유지한다.

**Prompt caching asymmetry.** Sonnet supports prompt caching with read-rate `$0.30/1M` (10% of full input price). The router system prompt and the NL→query prompts are invariant across requests; caching gives a disproportionate win on the high-QPS Sonnet flows while Opus flows are low enough QPS to not benefit meaningfully.

프롬프트 캐싱 비대칭. Sonnet은 프롬프트 캐싱을 지원하며 read 요율 `$0.30/1M`(입력 전액의 10%)이다. 라우터 시스템 프롬프트와 NL→쿼리 프롬프트는 요청 간 불변이므로 고 QPS Sonnet 경로에서 캐싱 이득이 비대칭적으로 크고, Opus 경로는 QPS가 낮아 체감 이득이 거의 없다.

**`global.` prefix and region pinning.** All Bedrock calls target `ap-northeast-2` runtime endpoints with the `global.` cross-region inference profile. This keeps the SDK call close to the dashboard (EC2 in `ap-northeast-2`) while letting Bedrock route inference to available capacity across regions. Commit `ba03173` specifically enforced this pattern on `alert-diagnosis.ts`, bringing it in line with `ai/route.ts`.

`global.` 접두사와 리전 고정. 모든 Bedrock 호출은 `ap-northeast-2` 런타임 엔드포인트 + `global.` 크로스 리전 추론 프로파일을 사용. 대시보드가 있는 `ap-northeast-2`에 SDK 호출은 가깝게 유지하면서, 추론은 Bedrock이 리전 간 가용 용량에 따라 라우팅하도록 한다. 커밋 `ba03173`이 이 패턴을 `alert-diagnosis.ts`에 강제 적용하여 `ai/route.ts`와 정렬시켰다.

**Why not Haiku for the router.** Haiku is cheaper and faster than Sonnet, but the router step is doing intent classification plus tool-name inference over a growing route table (11 routes as of v1.8.0, defined in `RouteConfig`). Misclassification is a first-class failure mode because a wrong route sends the request to the wrong gateway. Sonnet's classification reliability on ambiguous queries (e.g., "show me the slow pods" — container vs monitoring vs datasource) has been the observed floor during testing. The cost delta between Haiku and Sonnet on router-length prompts is dominated by the fixed latency overhead, so the Sonnet decision is defensible even on the cheap axis.

라우터에 Haiku를 쓰지 않는 이유. Haiku는 Sonnet보다 저렴·고속이지만, 라우터 단계는 증가하는 라우트 테이블(v1.8.0 기준 11 라우트, `RouteConfig` 정의) 위에서 의도 분류와 도구 이름 추론을 동시에 수행한다. 오분류는 1급 실패 모드 — 잘못된 라우트는 요청을 엉뚱한 게이트웨이로 보낸다. 모호한 질의(예: "느린 파드를 보여줘" — container vs monitoring vs datasource)에 대한 Sonnet의 분류 신뢰도가 테스트 중 관찰된 하한이었다. 라우터 길이의 프롬프트에서 Haiku와 Sonnet의 비용 차이는 고정 지연 오버헤드에 지배되므로, 비용 축에서도 Sonnet 결정은 방어 가능하다.

## Consequences / 결과

### Positive / 긍정적
- Alert diagnosis per-incident cost dropped ~5x and first-token latency improved materially versus the prior `us-east-1` Opus path.
- Opus quota is reserved for the flows whose output quality is the artifact (comprehensive report, scheduled full-report runs).
- Two-ID canonical list makes model upgrades a two-line change — the `MODELS` map in `ai/route.ts` is the effective registry.
- Prompt caching now pays off on the Sonnet-dominated high-QPS surface (router, NL→query).
- Per-route model selection is a config-level knob, not a business-logic change.

### Negative / 부정적
- Sonnet on alert diagnosis may miss edge-case reasoning that Opus would catch. Mitigated by the collector depth and the structured prompt in `alert-diagnosis.ts` (see ADR-009, Stage 3), and by the fact that on-demand deep investigation via AI chat still has an `opus-4.6` opt-in.
- Two canonical model IDs must be tracked and rotated together when new Claude versions ship. The `MODELS` map and the `MODEL_ID` constant in `report/route.ts` must stay aligned.
- Per-flow budget monitoring is now mandatory — the Bedrock Metrics dashboard page (`src/app/bedrock/page.tsx`) is the primary observability surface for this tradeoff, and the `agentcore-stats.ts` per-model token counters feed it.
- Other code paths (`src/app/api/datasources/route.ts:275`) hardcode the Sonnet ID directly instead of referencing the `MODELS` map; a follow-up cleanup would consolidate these.

## References / 참고 자료

### Internal
- Landing commit: `ba03173` — `fix: use global.anthropic.claude-sonnet-4-6 model ID for alert diagnosis`
- `src/lib/alert-diagnosis.ts` — alert orchestrator, `ANALYSIS_MODEL` constant (line 18)
- `src/app/api/ai/route.ts` — `MODELS` registry (lines 43-46), default `sonnet-4.6` across routes
- `src/app/api/report/route.ts` — `MODEL_ID` Opus constant (line 23), 15-section batches
- `src/app/api/datasources/route.ts` — Sonnet for NL→query generation (line 275)
- `src/app/api/bedrock-metrics/route.ts` — per-model pricing table (lines 22-34)
- `src/lib/agentcore-stats.ts` — per-model token usage tracking
- [ADR-002](002-ai-hybrid-routing.md) — AI hybrid routing, defines the 11 routes that share the Sonnet default
- [ADR-009](009-alert-triggered-ai-diagnosis.md) — Alert diagnosis pipeline, contains the Post-acceptance deviation note that prefigured this ADR

### External
- [Amazon Bedrock cross-region inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [Anthropic prompt caching on Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [Anthropic Claude model pricing](https://www.anthropic.com/pricing)
