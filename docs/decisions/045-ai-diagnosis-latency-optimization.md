# ADR-045: AI diagnosis latency — parallel section rendering + streaming on Bedrock (no SDK swap) / AI 진단 지연 — Bedrock 섹션 병렬 렌더 + 스트리밍 (SDK 교체 없음)

## Status / 상태

Accepted (2026-06-18) / 채택 (2026-06-18) — owner decision after a code-grounded latency analysis in-session. The implementation (parallel rendering, then streaming) is a follow-up; this ADR fixes the *approach* and explicitly rejects an SDK swap.
오너 결정 — 세션 내 코드 기반 지연 분석 후 확정. 구현(병렬 렌더 → 스트리밍)은 후속 작업이며, 본 ADR은 *접근법*을 확정하고 SDK 교체를 명시적으로 기각합니다.

## Context / 컨텍스트

The AI Diagnosis worker (`scripts/v2/workers/diagnosis/report.py`) renders a Well-Architected report by calling Bedrock once per section. The deep tier has 15 sections, and `generate()` renders them in a **sequential loop** (`for sec in catalog: rendered.append(render_section(...))`), each via a **non-streaming** `bedrock-runtime.invoke_model` on a `global.*` cross-region inference profile (Sonnet 4.6 / Opus 4.8). Wall-clock latency is therefore roughly the **sum** of 15 model calls — slow for a deep report.

AI 진단 워커(`report.py`)는 섹션당 Bedrock을 1회 호출해 Well-Architected 리포트를 만듭니다. deep 티어는 15섹션이며 `generate()`가 이를 **순차 루프**로 렌더하고, 각 호출은 `global.*` 크로스리전 추론 프로파일에서 **비-스트리밍** `invoke_model`로 수행됩니다. 따라서 벽시계 지연은 사실상 15회 모델 호출의 **합**이라 deep 리포트가 느립니다.

The question raised: should we use the Anthropic Python SDK directly (or some other SDK) to go faster? Investigation found the diagnosis worker is **already a direct Bedrock call** (raw boto3, Anthropic Messages protocol) — it does **not** use Strands. Strands is used only by the conversational chat agent (`agent/agent.py`, AgentCore), where a tool-use loop is genuinely needed. So the SDK layer is not the latency bottleneck for diagnosis.

제기된 질문: 더 빠르게 하려면 Anthropic Python SDK를 직접 쓰는 게 나을까? 조사 결과 진단 워커는 **이미 직접 Bedrock 호출**(raw boto3, Anthropic Messages 프로토콜)이며 Strands를 쓰지 **않습니다**. Strands는 도구 루프가 실제로 필요한 대화형 챗 에이전트(`agent/agent.py`, AgentCore)에만 쓰입니다. 즉 진단의 지연 병목은 SDK 계층이 아닙니다.

## Options Considered / 검토한 옵션

### Option 1: Anthropic SDK direct to api.anthropic.com / Anthropic API 직결
- **Pros**: marginally fewer hops than the Bedrock proxy. / Bedrock 프록시보다 홉이 약간 적음.
- **Cons**: leaves AWS entirely — loses IAM auth (needs a managed API key), VPC egress posture, ap-northeast-2 data residency, and the Bedrock invocation-log cost attribution that `ai_usage_daily` depends on. The gain is a few ms; the architectural cost is large. / AWS를 완전히 벗어남 — IAM 인증(별도 API 키 필요)·VPC·데이터 레지던시·`ai_usage_daily`가 의존하는 Bedrock invocation-log 비용 귀속을 모두 잃음. 이득은 수 ms, 구조적 비용은 큼.

### Option 2: Anthropic SDK `AnthropicBedrock` wrapper / Anthropic SDK의 Bedrock 래퍼
- **Pros**: nicer ergonomics (typed messages, streaming helpers) while staying on Bedrock/IAM. / Bedrock·IAM 유지하면서 더 나은 사용성.
- **Cons**: it is a **thin HTTP wrapper over the same Bedrock endpoint** — same model, same routing, **no speed gain**; adds a dependency for no latency benefit. / **같은 Bedrock 엔드포인트의 얇은 래퍼** — 동일 모델·동일 라우팅이라 **속도 이득 없음**, 지연 개선 없이 의존성만 추가.

### Option 3: Parallel per-section rendering + streaming, stay on boto3/Bedrock (chosen) / 섹션 병렬 렌더 + 스트리밍, boto3/Bedrock 유지 (채택)
- **Pros**: attacks the actual bottleneck. Bounded-concurrency parallel `invoke_model` turns wall-clock from a sum into ~max of the slowest section; streaming cuts perceived first-token latency. Stays on Bedrock (IAM/VPC/residency/cost attribution intact). No new SDK/dependency. / 진짜 병목을 공략. 동시성 제한 병렬 `invoke_model`로 벽시계를 합→최대치로, 스트리밍으로 체감 first-token 지연↓. Bedrock 유지(권한·비용 귀속 보존), 신규 SDK/의존성 없음.
- **Cons**: must respect Bedrock per-model TPM/RPM throttling limits (bounded concurrency + retry/backoff); per-section timeout isolation must be preserved so one slow section can't stall the job; streaming output assembly is more complex than the current append loop. / Bedrock 모델별 TPM/RPM 스로틀 한계를 지켜야 함(동시성 제한+백오프), 한 섹션이 잡 전체를 막지 않도록 섹션별 타임아웃 격리 유지, 스트리밍 조립이 현 append 루프보다 복잡.

### Option 4: Switch `global.*` → regional inference profile / `global.*` → 리전 프로파일 전환
- **Pros**: a regional (ap-northeast-2) profile avoids global cross-region routing latency. / 리전 프로파일은 글로벌 크로스리전 라우팅 지연을 피함.
- **Cons**: the `global.*` profile is required for awsops-only cost attribution via Bedrock invocation logs (ADR/feature `ai_usage_daily`); switching breaks attribution. Not adopted as the primary lever. / `global.*`는 invocation-log 기반 awsops 비용 귀속에 필요 → 전환 시 귀속 깨짐. 주 레버로 채택하지 않음.

## Decision / 결정

Keep the current substrate: **boto3 `bedrock-runtime` for the diagnosis worker, Strands for the chat agent.** Do **not** swap to the Anthropic SDK or to the direct Anthropic API — the SDK is not the latency lever for a single-shot per-section call.

현 기반 유지: **진단 워커는 boto3 `bedrock-runtime`, 챗 에이전트는 Strands.** Anthropic SDK나 직결 API로 **교체하지 않음** — 단발 섹션 호출에서 SDK는 지연 레버가 아님.

Optimize diagnosis latency, in priority order:
1. **Parallelize per-section rendering** with bounded concurrency (e.g. a worker pool sized to stay under Bedrock TPM/RPM), preserving each section's existing read/connect timeout and graceful-degrade contract. This is the largest wall-clock win.
2. **Stream** section output (`invoke_model_with_response_stream`) to reduce perceived latency / enable progressive UI.
3. Keep `global.*` profiles (cost attribution) unless a measured latency case justifies a regional profile for a specific tier.

진단 지연 최적화는 우선순위순으로:
1. **섹션 렌더 병렬화**(Bedrock TPM/RPM 아래로 유지되는 동시성 제한 풀), 섹션별 타임아웃·degrade 계약 보존. 벽시계 최대 이득.
2. 섹션 출력 **스트리밍**으로 체감 지연↓ / 점진적 UI.
3. 비용 귀속 위해 `global.*` 유지 — 측정상 정당화될 때만 특정 티어에 리전 프로파일.

This stays fully read-only (no AWS-resource mutation, no autonomy) and changes only the diagnosis worker's rendering orchestration.
전 구간 read-only 유지(AWS 리소스 변경·자율 없음), 진단 워커의 렌더 오케스트레이션만 변경.

## Consequences / 결과

### Positive / 긍정적
- Deep (15-section) reports finish in roughly the slowest-section time instead of the sum — a large wall-clock reduction. / deep(15섹션) 리포트가 합이 아닌 최장 섹션 시간 수준으로 단축 — 벽시계 대폭 감소.
- Streaming improves perceived speed and pairs with the existing per-section progress events. / 스트리밍으로 체감 속도↑, 기존 섹션 진행 이벤트와 결합.
- No new SDK, no leaving Bedrock — IAM/VPC/residency and `ai_usage_daily` cost attribution are preserved. / 신규 SDK·Bedrock 이탈 없음 — 권한·레지던시·비용 귀속 보존.

### Negative / 부정적
- Concurrency must be bounded and back off on Bedrock throttling; a naive fan-out of 15 calls risks `ThrottlingException`. / 동시성은 제한·백오프 필수 — 15콜 무차별 fan-out은 `ThrottlingException` 위험.
- Streaming assembly and parallel result ordering add code complexity vs the current sequential append. / 스트리밍 조립·병렬 결과 정렬이 현 순차 append보다 복잡.
- Per-section failure isolation must be retained under parallelism so the report still degrades to `partial` rather than failing whole. / 병렬 하에서도 섹션 실패 격리 유지 — 리포트가 전체 실패가 아닌 `partial`로 degrade.

## References / 참고 자료
- `scripts/v2/workers/diagnosis/report.py` — `generate()` sequential loop, `_bedrock_render` non-streaming `invoke_model`.
- `agent/agent.py` — Strands agent (chat path; tool-use loop) — unchanged by this ADR.
- ADR-016 (Bedrock model selection), ADR-019 (diagnosis report format), ADR-021 (SSE streaming for AI).
- Anthropic Python SDK (incl. `AnthropicBedrock`): https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/python
- `ai_usage_daily` / Bedrock invocation-log cost attribution (relies on `global.*` profiles).
