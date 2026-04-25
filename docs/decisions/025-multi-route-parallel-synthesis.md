# ADR-025: Multi-Route Parallel Synthesis for AI Queries / 멀티 라우트 병렬 합성

## Status / 상태

Accepted (2026-04-22) / 채택됨 (2026-04-22)

## Context / 컨텍스트

ADR-002 established the 11-route hybrid AI router in `src/app/api/ai/route.ts`, which maps each user question to a specialized AgentCore Gateway (Network, Security, Data, Monitoring, Cost, etc.). The original design assumed a single route per question, but real operator questions frequently cross domain boundaries: "My EKS pod is failing — is the cause a network policy, a missing IAM permission, or a CloudWatch metric spike?" forces the user either to ask three separate questions or to accept a partial answer from one Gateway. Neither is acceptable for an incident-response dashboard where time-to-insight dominates.

ADR-002는 `src/app/api/ai/route.ts`의 11 라우트 하이브리드 AI 라우터를 확립했으며, 각 사용자 질문을 전문 AgentCore 게이트웨이(Network, Security, Data, Monitoring, Cost 등)로 매핑한다. 원래 설계는 질문당 단일 라우트를 가정했지만, 실제 운영자의 질문은 도메인 경계를 자주 가로지른다: "EKS 파드 장애 — 네트워크 정책, IAM 권한 부재, CloudWatch 메트릭 스파이크 중 무엇이 원인인가?"는 사용자에게 세 번의 개별 질문을 강요하거나 한 게이트웨이의 부분 답변을 받아들이게 한다. 시간 대비 인사이트가 지배하는 장애 대응 대시보드에서는 두 경로 모두 받아들이기 어렵다.

Constraints:
- Classifier latency must remain within one Sonnet round-trip (~1.5s p50).
- Parallel Gateway calls must not explode the token bill on routine single-domain questions.
- Each Gateway has independent AWS IAM scope and rate limits (ADR-004); cross-Gateway state sharing is not available.
- The UI already streams a single answer via SSE (see streaming route behavior in `src/app/api/ai/route.ts`); any multi-route design must preserve that single-stream UX.

제약:
- 분류기 지연은 Sonnet 1회 왕복 이내(~1.5s p50)를 유지해야 한다.
- 단일 도메인 질문에서 병렬 게이트웨이 호출로 토큰 비용이 폭증해서는 안 된다.
- 게이트웨이마다 독립된 AWS IAM 범위·Rate Limit을 갖는다(ADR-004). 게이트웨이 간 상태 공유는 없다.
- UI는 이미 SSE로 단일 답변을 스트리밍하므로, 멀티 라우트 설계는 단일 스트림 UX를 유지해야 한다.

## Options Considered / 검토한 대안

### Option 1 — Multi-route classifier + `Promise.allSettled` + Bedrock synthesis (chosen)
The Sonnet classifier returns `{"routes": [...]}` with 1-3 entries, slice-capped at 3. The streaming handler fans out with `Promise.allSettled`, then a second Bedrock (Sonnet, ConverseStream) call merges the surviving Gateway outputs into one markdown answer that streams token-by-token to the client.

Sonnet 분류기가 `{"routes": [...]}`를 1-3개 반환하고 코드에서 3개로 절단한다. 스트리밍 핸들러가 `Promise.allSettled`로 부채꼴 호출하고, 두 번째 Bedrock(Sonnet ConverseStream) 호출이 살아남은 게이트웨이 응답을 하나의 마크다운 답변으로 병합하여 토큰 단위로 클라이언트에 스트리밍한다.

### Option 2 — Single-route only, rely on Gateway tools to cross-call
Keep the original ADR-002 single-route output. Teach each Gateway's agent to delegate to sibling Gateways via MCP tool calls when it detects a cross-domain question.

단일 라우트 유지. 각 게이트웨이 에이전트가 교차 도메인 질문을 감지하면 MCP 도구 호출로 인접 게이트웨이에 위임하도록 학습시킨다.

Rejected: duplicates classifier logic inside every agent, doubles Gateway warm-start cost when delegation happens, and produces unpredictable call graphs that are hard to rate-limit or cost-attribute.

기각: 분류기 로직이 모든 에이전트에 중복되고, 위임 시 게이트웨이 콜드 스타트 비용이 두 배가 되며, 호출 그래프가 예측 불가능해 Rate Limit·비용 귀속이 어려워진다.

### Option 3 — Sequential router (answer, re-classify, ask again)
Answer with the top route, then re-run the classifier on the follow-up to chain additional routes.

상위 라우트로 답변한 뒤 후속 질문을 재분류하여 추가 라우트로 체이닝한다.

Rejected: total latency becomes N x (classifier + Gateway) instead of max(parallel) + synthesis; users must type a follow-up to get the full picture.

기각: 총 지연이 max(parallel) + synthesis 대신 N x (classifier + Gateway)가 되며, 전체 그림을 보려면 후속 질문을 타이핑해야 한다.

### Option 4 — Single Bedrock call with all 125 MCP tools attached
Skip routing entirely; give Bedrock the full 125-tool catalog and let the model decide.

라우팅을 생략하고 Bedrock에 전체 125개 도구 카탈로그를 주어 모델이 결정하게 한다.

Rejected: tool-selection prompt grows past 30k tokens, classifier accuracy degrades on long catalogs (observed regression with 40+ tools), and ADR-004's IAM role split cannot be enforced from a single agent.

기각: 도구 선택 프롬프트가 30k 토큰을 넘고, 긴 카탈로그에서 분류 정확도가 저하되며(40+ 도구에서 회귀 관측), ADR-004의 IAM 역할 분리를 단일 에이전트에서 강제할 수 없다.

## Decision / 결정

Adopt **Option 1**. The classifier in `classifyIntent()` returns a `routes: RouteType[]` array, capped at three entries via `.slice(0, 3)`. When `routes.length > 1`, the streaming handler fans out the selected routes with `Promise.allSettled(routes.map(r => handleSingleRoute(...)))`. Surviving results enter `synthesizeResponsesStreaming()`, which issues a second Bedrock call using `ConverseStreamCommand` against `global.anthropic.claude-sonnet-4-6` with a system instruction to "combine them into one coherent, well-structured response. Do not repeat information." The merged answer streams to the client as SSE `chunk` events, identical to single-route flow, and the final `done` event carries `routes: [...]`, `via: "Multi-Route: ..."`, and the deduplicated `usedTools` list.

**옵션 1**을 채택한다. `classifyIntent()` 분류기는 `routes: RouteType[]` 배열을 반환하며 `.slice(0, 3)`으로 최대 3개로 제한된다. `routes.length > 1`이면 스트리밍 핸들러가 `Promise.allSettled(routes.map(r => handleSingleRoute(...)))`로 부채꼴 호출한다. 살아남은 응답은 `synthesizeResponsesStreaming()`에 들어가, `global.anthropic.claude-sonnet-4-6` 모델에 `ConverseStreamCommand`로 두 번째 Bedrock 호출을 발행한다. 시스템 지시는 "일관되고 잘 구성된 하나의 응답으로 결합하라. 정보를 반복하지 말라"이다. 병합 답변은 단일 라우트와 동일하게 SSE `chunk` 이벤트로 스트리밍되며, 최종 `done` 이벤트는 `routes: [...]`, `via: "Multi-Route: ..."`, 중복 제거된 `usedTools`를 전달한다.

```ts
// src/app/api/ai/route.ts — parallel + synthesis core / 병렬 + 합성 핵심
const results = await Promise.allSettled(
  routes.map(r => handleSingleRoute(r, messages, modelKey, clientLang, accountId, account?.alias))
);
// ...collect successful
if (successful.length > 1) {
  const synthesized = await synthesizeResponsesStreaming(lastMsg, successful, send, modelKey, clientLang);
}
```

## Rationale / 근거

- **1-3 range instead of always 1**: Empirically, 20-30% of operator questions span two domains; a hard single-route cap forces partial answers. A hard cap of 3 keeps classifier accuracy high (few-shot examples fit in 100 output tokens) while covering the dominant pattern of primary + two adjacent domains.
- **항상 1개가 아닌 1-3 범위**: 운영자 질문의 20-30%가 두 도메인에 걸친다. 단일 라우트 강제는 부분 답변을 유도한다. 3개 상한은 분류 정확도를 유지(few-shot 예시가 100 출력 토큰 내)하면서 주 도메인 + 2개 인접 도메인이라는 지배적 패턴을 포괄한다.
- **Cap at 3, not higher**: beyond three, prompt-assembly latency for the synthesis step grows non-linearly and classifier precision degrades on long route lists. Three is the elbow of the cost-coverage curve.
- **3개 상한**: 3개를 넘으면 합성 단계 프롬프트 조립 지연이 비선형으로 증가하고, 긴 라우트 리스트에서 분류 정밀도가 저하된다. 3이 비용-커버리지 곡선의 엘보우다.
- **`Promise.allSettled` over sequential**: each Gateway calls a different Lambda against a different AWS API; their latencies are independent. Sequential would multiply wall-clock time by N.
- **순차 대신 `Promise.allSettled`**: 각 게이트웨이는 서로 다른 AWS API를 호출하는 별도 람다를 트리거한다. 지연은 독립적이다. 순차 실행은 벽시계 시간을 N배로 늘린다.
- **Bedrock synthesis over concatenation**: raw concatenation produces three walls of text with duplicated headers. A dedicated synthesis prompt produces a single answer with merged summary and per-domain sections.
- **단순 연결 대신 Bedrock 합성**: 원시 연결은 중복 헤더가 있는 세 개의 텍스트 덩어리를 만든다. 전용 합성 프롬프트는 통합 요약 + 도메인별 섹션을 가진 단일 답변을 생성한다.
- **Synthesis on Sonnet, not Opus**: per ADR-016, latency-sensitive flows default to Sonnet. Synthesis input is short (three Gateway outputs) and its output target is 4096 tokens — Opus adds ~3-4x latency and cost with no observed quality gain on this kind of merge task.
- **Opus가 아닌 Sonnet 합성**: ADR-016에 따라 지연 민감 플로우는 Sonnet을 기본으로 한다. 합성 입력은 짧고(세 게이트웨이 응답) 출력 목표는 4096 토큰이다. Opus는 이 병합 작업에서 품질 이득 없이 지연·비용을 3-4배 늘린다.
- **`allSettled` over `all`**: one Gateway failure (timeout, throttle, Lambda cold start) must not kill the entire response. With `allSettled`, synthesis runs over the surviving responses and `via: "Multi-Route: ..."` records which routes contributed.
- **`all` 대신 `allSettled`**: 한 게이트웨이 장애(타임아웃, 스로틀, 람다 콜드 스타트)가 전체 응답을 죽여서는 안 된다. `allSettled`로 생존 응답만 합성하고, `via: "Multi-Route: ..."`가 기여한 라우트를 기록한다.
- **Per-route token tracking**: `recordCall()` in `agentcore-stats.ts` receives `gateway: 'multi:network+cost'` for the synthesis record, and each `handleSingleRoute` independently records its own per-Gateway counters. The Bedrock dashboard therefore attributes cost to the right gateway even in multi-route mode.
- **라우트별 토큰 추적**: `agentcore-stats.ts`의 `recordCall()`은 합성 레코드에 `gateway: 'multi:network+cost'`를 받고, `handleSingleRoute`마다 자체 게이트웨이 카운터를 독립적으로 기록한다. 따라서 멀티 라우트에서도 Bedrock 대시보드는 비용을 올바른 게이트웨이에 귀속한다.

## Consequences / 결과

### Positive / 긍정적
- Cross-domain questions get one streaming answer in a single round-trip instead of forcing the user to ask N separate questions.
- Parallel fan-out keeps wall-clock latency at `max(Gateway_i) + synthesis` rather than the sum.
- Partial failure is handled gracefully: `successful.length === 1` skips synthesis and streams the single survivor; `successful.length === 0` triggers Bedrock Direct streaming fallback with `via: "Bedrock Direct (multi-route fallback: ... timed out)"`.
- `routes: [...]` is emitted on the `done` SSE event so the UI can display the chip set "Network + Security" and let users click through to see which Gateway produced which section.
- Per-route and synthesis token usage are recorded separately in `agentcore-stats.ts`, preserving the Bedrock dashboard's cost attribution.
- 교차 도메인 질문을 단일 왕복의 스트리밍 답변으로 해결한다.
- 병렬 부채꼴로 벽시계 지연이 합계가 아닌 `max(Gateway_i) + synthesis`다.
- 부분 장애 처리: 성공 1 → 합성 생략 후 단일 응답 스트리밍, 성공 0 → Bedrock Direct 스트리밍 폴백.
- `done` SSE 이벤트에 `routes: [...]`가 실려 UI가 "Network + Security" 칩셋을 표시하고 사용자가 어느 게이트웨이가 어느 섹션을 생성했는지 확인할 수 있다.
- 라우트별·합성 토큰 사용량이 `agentcore-stats.ts`에 분리 기록되어 Bedrock 대시보드 비용 귀속이 유지된다.

### Negative / 부정적
- Synthesis adds a second Bedrock call per multi-route question — roughly +400ms p50 and +4096 output tokens worst case on top of the parallel Gateway costs.
- The cap of 3 is a policy knob: edge-case questions needing a fourth domain are silently truncated after slicing. Classifier tuning through `CLASSIFICATION_PROMPT` examples is required when mis-routing is observed.
- Cost accounting across the parallel + synthesis calls is more complex; `multi:` gateway labels are needed to keep the Bedrock dashboard readable.
- Classifier tuning is harder because the output is an array (`{"routes":[...]}`) instead of a single string — evaluation harnesses must score set overlap, not exact match.
- Gateway rate limits can bite when all three routes target the same Lambda (e.g. Network + Data both invoking a shared helper), though ADR-004's role split makes this rare.
- 합성이 멀티 라우트 질문당 Bedrock 호출을 하나 더 추가한다 — 병렬 게이트웨이 비용 위에 p50 +400ms, 최악 +4096 출력 토큰.
- 3개 상한은 정책 노브다: 네 번째 도메인이 필요한 엣지 케이스는 절단 후 조용히 누락된다. 오라우팅 관측 시 `CLASSIFICATION_PROMPT` 예시 튜닝이 필요하다.
- 병렬 + 합성 호출에 걸친 비용 계산이 복잡해지므로 Bedrock 대시보드 가독성을 위해 `multi:` 게이트웨이 라벨이 필요하다.
- 분류기 튜닝이 더 어렵다: 출력이 단일 문자열이 아닌 배열(`{"routes":[...]}`)이므로 평가 하네스는 정확 일치가 아닌 집합 중첩을 채점해야 한다.
- 세 라우트가 동일 람다를 공유 호출하면 게이트웨이 Rate Limit이 걸릴 수 있으나, ADR-004의 역할 분리로 드물다.

## References / 참조

- Code: `src/app/api/ai/route.ts` — `classifyIntent()` (lines ~399-444), multi-route fan-out block (lines ~1216-1293), `synthesizeResponses()` and `synthesizeResponsesStreaming()` (lines ~1527-1578)
- Code: `src/lib/agentcore-stats.ts` — `recordCall()` per-route and `multi:` gateway tagging
- Root `CLAUDE.md` AI Routing table — 11-route priority list cross-referenced by the classifier prompt
- ADR-002 (`002-ai-hybrid-routing.md`) — underlying routing priorities, extended here to N-route fan-out
- ADR-004 (`004-gateway-role-split.md`) — per-Gateway IAM scope; each parallel call obeys its Gateway's role
- ADR-016 (`016-bedrock-model-selection-strategy.md`) — justification for Sonnet on the synthesis step
- ADR-021 (SSE streaming strategy) — the multi-route result streams via the same SSE contract; `chunk` and `done` events apply unchanged
