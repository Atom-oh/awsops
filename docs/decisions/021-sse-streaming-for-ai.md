# ADR-021: Server-Sent Events (SSE) Streaming for AI Responses / AI 응답 SSE 스트리밍

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

The AI Assistant route at `src/app/api/ai/route.ts` calls Bedrock (Sonnet/Opus 4.6) directly or indirectly through AgentCore Runtime and eight Gateways (125 MCP tools, per ADR-002). A full request-response cycle can take 10-60 seconds: intent classification, AgentCore Runtime spin-up, Gateway tool invocation, Steampipe SQL retry, external datasource query, and final Bedrock synthesis. Blocking the browser on a single JSON response that long produces a "frozen" UX — users cannot tell whether the request is running, stalled, or failed, and they receive no visibility into which Gateway was selected or which tools were invoked. The route also needs to advertise multi-phase progress (classification, routing, SQL execution, Bedrock streaming, tool usage) rather than a single opaque status. The same progress pattern appears in the auto-collect investigation agents (ADR-013) and in `src/lib/report-generator.ts` for diagnosis reports, all of which emit step-by-step events through a shared `SendFn` contract defined in `src/lib/collectors/types.ts`.

`src/app/api/ai/route.ts`의 AI 어시스턴트는 Bedrock(Sonnet/Opus 4.6)을 직접 호출하거나 AgentCore Runtime 및 8개 Gateway(125 MCP 도구, ADR-002)를 경유한다. 한 요청의 전체 수명 — 의도 분류, AgentCore Runtime 시작, Gateway 도구 호출, Steampipe SQL 재시도, 외부 데이터소스 쿼리, 최종 Bedrock 합성 — 은 10-60초가 걸릴 수 있다. 이 시간을 단일 JSON 응답으로 블로킹하면 사용자는 요청이 실행 중인지, 멈췄는지, 실패했는지 구분하지 못하고, 어느 Gateway가 선택되었으며 어떤 도구가 호출되었는지 가시성도 없다. 게다가 라우트는 "분류 → 라우팅 → SQL 실행 → Bedrock 스트리밍 → 도구 사용"이라는 다단계 진행 상황을 단일 불투명 상태가 아니라 단계별로 노출해야 한다. 같은 패턴이 자동 수집 조사 에이전트(ADR-013)와 `src/lib/report-generator.ts`의 진단 리포트 수집기에도 나타나며, 모두 `src/lib/collectors/types.ts`에 정의된 공유 `SendFn` 계약으로 이벤트를 방출한다.

## Options Considered / 검토한 대안

### Option 1 — Server-Sent Events (SSE) over Next.js `ReadableStream` / SSE (채택)

The App Router `route.ts` returns `new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } })`, where `readable` is a `ReadableStream` whose `start(controller)` function enqueues UTF-8-encoded `event: <name>\ndata: <JSON>\n\n` frames. The browser consumes the stream via `fetch().body.getReader()` + `TextDecoder`, splits on newline boundaries, and dispatches events by name. One HTTP connection, no upgrade handshake, idiomatic Next.js 14.2.35.

App Router의 `route.ts`는 `new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } })`를 반환한다. `readable`은 `ReadableStream`이며, `start(controller)`에서 `event: <이름>\ndata: <JSON>\n\n` 프레임을 UTF-8로 인코딩해 enqueue한다. 브라우저는 `fetch().body.getReader()` + `TextDecoder`로 스트림을 읽고 개행 기준으로 분리하여 이벤트 이름별로 디스패치한다. 단일 HTTP 커넥션, 업그레이드 핸드셰이크 없음, Next.js 14.2.35에 자연스러운 형태다.

### Option 2 — WebSocket / 웹소켓

A WebSocket server (e.g., `ws` package with a custom Next.js server, or an ALB-fronted socket service) would open a bidirectional channel. Each AI request would reserve a socket, emit progress frames in one direction, and close the socket on `done`. Bidirectional capacity is unused — AI responses are strictly server-to-client after the initial POST body is received.

WebSocket 서버(예: `ws` 패키지 + Next.js 커스텀 서버, 또는 ALB 앞단의 소켓 서비스)는 양방향 채널을 연다. AI 요청마다 소켓을 할당하고, 한 방향으로 진행 프레임을 전송한 뒤 `done`에서 소켓을 닫는다. 초기 POST 바디 수신 이후로는 서버→클라이언트 단방향 흐름만 필요하므로 양방향 용량은 사용되지 않는다.

### Option 3 — Full JSON response after LLM completes / LLM 완료 후 단일 JSON 응답

Block the browser on `await streamBedrockToSSE(...)` equivalent, accumulate the full Bedrock output server-side, and return `{ content, via, queriedResources, usedTools, inputTokens, outputTokens }` as a single `application/json` response. Already available as the "non-streaming mode" branch (`handleNonStreaming`) retained for test scripts.

서버에서 Bedrock 출력을 전부 누적한 뒤 `{ content, via, queriedResources, usedTools, inputTokens, outputTokens }`를 단일 `application/json` 응답으로 반환한다. 현재도 테스트 스크립트용으로 `handleNonStreaming` 경로가 남아 있다.

## Decision / 결정

AWSops uses Server-Sent Events (Option 1) for every long-running AI flow that renders progress or token-level content in the browser. The emitter pattern is standardized as a `SendFn = (event: string, data: any) => void` (`src/lib/collectors/types.ts`) and the on-the-wire frame is produced by a single helper in `src/app/api/ai/route.ts`:

AWSops는 브라우저에서 진행 상황이나 토큰 단위 콘텐츠를 렌더해야 하는 모든 장시간 AI 플로우에 SSE(Option 1)를 사용한다. 이미터 패턴은 `SendFn = (event: string, data: any) => void`(`src/lib/collectors/types.ts`)로 표준화되어 있으며, 와이어 프레임은 `src/app/api/ai/route.ts`의 단일 헬퍼가 생성한다.

```ts
// src/app/api/ai/route.ts
function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

Event names emitted on the AI route / AI 라우트가 방출하는 이벤트 이름:

```text
status   Progress frame (classifying, classified, sql-generating, sql-querying,
         sql-retrying, analyzing, agentcore, multi-call, synthesizing,
         datasource-generating, datasource-querying, datasource-analyzing,
         fallback, <route>-analyzing, <route>-error). Carries { step, message, ... }.
chunk    Incremental token delta from Bedrock streaming or simulateStreaming().
         Carries { delta: string }.
done     Terminal event with the full content and metadata. Carries
         { content, model, via, queriedResources, route, usedTools,
           inputTokens, outputTokens }.
error    Terminal failure. Carries { error: string }.
```

Shared contract across callers / 호출자 간 공유 계약:

```text
/api/ai                    HTTP SSE surface (only route that returns text/event-stream)
report-generator.ts        Uses SendFn to emit status events during Steampipe +
                           CloudWatch + datasource collection.
alert-diagnosis.ts         Uses SendFn = nullSend when running in background
                           (alert webhook path) — the frame contract is honored
                           so the same collectors can be wired into an SSE
                           surface later without code changes.
collectors/*.ts            All seven auto-collect agents (ADR-013) accept SendFn
                           and emit status frames for their own phases.
```

Client-side consumption (`src/app/ai/page.tsx`) reads `res.body.getReader()`, accumulates a buffer, splits on `\n`, parses `event: <name>` and `data: <json>` line pairs, and dispatches:

클라이언트 소비(`src/app/ai/page.tsx`)는 `res.body.getReader()`로 읽고 버퍼에 누적한 뒤 `\n`으로 나누어 `event: <이름>` / `data: <json>` 쌍을 파싱하고 디스패치한다:

```ts
// src/app/ai/page.tsx — SSE consumption
if (contentType.includes('text/event-stream') && res.body) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // ...split buffer on \n, parse `event:` + `data:` pairs, dispatch...
}
```

The "non-streaming mode" JSON branch (Option 3) is retained as a backward-compatibility path for test scripts and for the `ai-diagnosis` page, which uses short-polling against `/api/report?action=status&id=…` instead of SSE because the report job already persists to S3 and the UI only needs terminal status.

Option 3의 JSON 비스트리밍 경로는 테스트 스크립트 하위 호환 목적으로 유지되며, `ai-diagnosis` 페이지는 리포트 잡이 이미 S3에 영속화되므로 SSE 대신 `/api/report?action=status&id=…`에 대한 짧은 폴링을 사용한다.

## Rationale / 근거

- **SSE is HTTP-native** and works through the Next.js App Router `Response` + `ReadableStream` without a custom server, which is required to keep the CloudFront → ALB → EC2 path (per root CLAUDE.md) and the Lambda@Edge Cognito auth gate intact. A WebSocket upgrade would need a parallel ingress path and re-authentication.

  SSE는 HTTP 네이티브이고, Next.js App Router의 `Response` + `ReadableStream`만으로 커스텀 서버 없이 동작하므로 루트 CLAUDE.md의 CloudFront → ALB → EC2 경로와 Lambda@Edge Cognito 인증 게이트를 그대로 유지할 수 있다. WebSocket 업그레이드는 병렬 인그레스 경로와 재인증을 요구한다.

- **Server-to-client is the actual shape of an LLM stream.** Once the POST request body is received, the client has nothing more to say — there are no mid-stream user events other than cancellation. WebSocket's bidirectionality is unused capacity that still costs an extra connection lifecycle and explicit reconnect logic.

  POST 바디 수신 이후 LLM 스트림은 실질적으로 서버→클라이언트 단방향이다. 클라이언트가 중간에 보낼 이벤트는 취소 외에 없다. WebSocket의 양방향성은 사용되지 않는 용량이며, 별도 연결 수명주기와 재연결 로직 비용을 부과한다.

- **Long-polling would double the bandwidth and add latency.** Each chunk would require a fresh request with full headers, introduce inter-chunk latency, and make cancellation brittle (the server cannot tell a cancel from a disconnect until the next poll). SSE keeps one connection open and streams frames at Bedrock's natural rate.

  Long-polling은 청크마다 전체 헤더를 다시 보내 대역폭을 두 배로 만들고, 청크 간 지연을 추가하며, 취소를 불안정하게 만든다 — 서버는 다음 폴 때까지 취소와 단순 단절을 구분할 수 없다. SSE는 하나의 커넥션을 열어 Bedrock이 생성하는 속도 그대로 프레임을 전송한다.

- **Structured frames, not raw token concatenation.** Naming events (`status`, `chunk`, `done`, `error`) lets the UI render status lines, typing cursors, and terminal metadata (tools used, model, token counts) separately from LLM prose. The AI Assistant page renders `status.message` as a live progress line, accumulates `chunk.delta` into a streaming buffer, and finalizes with `done.content` — this would be impossible with an unnamed character stream.

  프레임에 이름을 붙여(`status`, `chunk`, `done`, `error`) UI가 상태 라인, 타이핑 커서, 최종 메타데이터(도구 사용, 모델, 토큰 수)를 LLM 본문과 분리해 렌더할 수 있다. AI 어시스턴트 페이지는 `status.message`를 진행 라인으로, `chunk.delta`를 스트리밍 버퍼에 누적하고, `done.content`로 확정한다 — 이름 없는 문자 스트림으로는 불가능하다.

- **One `SendFn` contract, three callers.** `src/app/api/ai/route.ts`, `src/lib/report-generator.ts`, and `src/lib/alert-diagnosis.ts` (plus all collectors under `src/lib/collectors/*.ts`) share the same `(event, data) => void` signature. Only `/api/ai` wires that signature to an HTTP SSE surface today; the others pass `noop`/`nullSend` when invoked in the background (alert webhook, report generator). Reusing the same contract means any collector can be promoted to an SSE-streamed endpoint later with zero code change in the collector.

  `src/app/api/ai/route.ts`, `src/lib/report-generator.ts`, `src/lib/alert-diagnosis.ts`와 `src/lib/collectors/*.ts`의 모든 컬렉터가 동일한 `(event, data) => void` 시그니처를 공유한다. 오늘 이 시그니처를 HTTP SSE 표면에 연결한 라우트는 `/api/ai` 뿐이며, 나머지는 백그라운드 실행(알림 웹훅·리포트 생성) 시 `noop`/`nullSend`를 전달한다. 같은 계약을 재사용하므로 어떤 컬렉터든 추후 SSE 스트리밍 엔드포인트로 승격할 때 컬렉터 코드는 변경이 필요 없다.

- **Tool usage is inferred from the response text, not from `tool_call` metadata.** AgentCore Runtime returns only final text — there is no structured tool-call frame to stream (root CLAUDE.md "AgentCore Known Issues"). `extractUsedTools()` in `src/app/api/ai/route.ts` keyword-matches the response against `TOOL_KEYWORD_MAP` and sends the inferred list inside the terminal `done` event rather than as separate per-tool frames. This is imprecise — a false positive (mentioning "CloudTrail" without using the tool) or a false negative (using a tool whose keyword the response omits) is possible — and is accepted because AgentCore does not surface structured tool metadata.

  도구 사용은 응답 텍스트에서 추론한다. AgentCore Runtime은 최종 텍스트만 반환하며, 스트림할 수 있는 구조화된 tool-call 프레임이 없다(루트 CLAUDE.md "AgentCore Known Issues"). `src/app/api/ai/route.ts`의 `extractUsedTools()`는 응답을 `TOOL_KEYWORD_MAP`과 키워드 매칭한 뒤, 추론된 도구 목록을 도구별 별도 프레임이 아닌 종료 `done` 이벤트 안에 실어 보낸다. 이는 부정확하며(예: "CloudTrail"을 언급만 했거나, 반대로 도구를 썼는데 키워드가 응답에 없는 경우) AgentCore가 구조화된 도구 메타데이터를 노출하지 않기 때문에 수용되는 트레이드오프다.

- **Cancellation works natively via `AbortController`.** The browser calls `controller.abort()` on the underlying `fetch`; the stream-reader loop sees `done = true`; the Node.js `ReadableStream` closes and the emitter loop exits cleanly, releasing the Bedrock `InvokeModelWithResponseStreamCommand` iterator. WebSocket would require explicit close frames; long-polling would require server-side cancellation tokens keyed to a request ID.

  브라우저가 `fetch`의 `AbortController.abort()`를 호출하면 리더 루프가 `done = true`로 종료되고, Node.js의 `ReadableStream`이 닫혀 이미터 루프가 깨끗하게 종료되며 Bedrock의 `InvokeModelWithResponseStreamCommand` 이터레이터도 해제된다. WebSocket은 명시적 close 프레임을, long-polling은 요청 ID 키 기반 서버 취소 토큰을 별도로 요구한다.

## Consequences / 결과

### Positive / 긍정적

- **Progressive UI.** Users see status lines ("Running SQL", "Calling Container Gateway", "Synthesizing"), then Bedrock tokens typing in real time, then final metadata. A 45-second request never looks frozen.

  사용자는 상태 라인("SQL 실행 중", "Container Gateway 호출 중", "합성 중")을 먼저 본 뒤 Bedrock 토큰이 실시간으로 타이핑되고, 마지막에 최종 메타데이터를 받는다. 45초짜리 요청도 멈춰 보이지 않는다.

- **Structured event names** let the UI render section headers, tool badges, and progress bars in separate DOM regions without parsing prose.

  구조화된 이벤트 이름 덕분에 UI가 본문 파싱 없이 섹션 헤더, 도구 배지, 진행 바를 별도 DOM 영역에 렌더할 수 있다.

- **Unified `SendFn` contract** across AI route, report generator, alert diagnosis, and seven auto-collect agents — extending streaming to a new flow is a new HTTP handler, not a new contract.

  AI 라우트, 리포트 제너레이터, 알림 진단, 7개 자동 수집 에이전트가 동일한 `SendFn` 계약을 공유한다. 새 플로우에 스트리밍을 확장할 때 필요한 것은 새 계약이 아니라 새 HTTP 핸들러 뿐이다.

- **CloudFront + Lambda@Edge compatible.** SSE is plain HTTP/1.1 chunked streaming; no WebSocket upgrade handshake crosses the Lambda@Edge Cognito check.

  SSE는 일반 HTTP/1.1 청크 스트리밍이다. WebSocket 업그레이드 핸드셰이크가 Lambda@Edge Cognito 체크를 통과할 필요가 없다.

- **Cancellation is free** via `AbortController` on `fetch()` — no bespoke protocol.

  `fetch()`의 `AbortController`로 취소가 무료다 — 별도 프로토콜 불필요.

### Negative / Trade-offs / 부정적 / 트레이드오프

- **SSE is one-way.** The client cannot send mid-stream events (other than cancellation). A feature like "let the user answer a clarifying question mid-response" would require a separate POST or a WebSocket — not SSE.

  SSE는 단방향이다. 클라이언트가 스트림 중간에 이벤트(취소 제외)를 보낼 수 없다. "응답 도중 사용자에게 추가 질문을 던져 답을 받는" 식의 기능은 별도 POST나 WebSocket이 필요하다.

- **Tool-use inference is imprecise.** Keyword matching on the response can both miss tools (no keyword hit) and falsely claim tools (response happens to mention a keyword without using the tool). Fixing this requires AgentCore to surface structured tool metadata, which it does not today.

  도구 사용 추론은 응답 텍스트의 키워드 매칭이라 누락(키워드가 안 나옴)과 오탐(도구 미사용인데 키워드 언급)이 모두 가능하다. 정확도 개선은 AgentCore가 구조화된 도구 메타데이터를 노출해야 가능하며 현재는 제공되지 않는다.

- **Long-lived requests occupy Node.js connections.** A 60-second AI request keeps an HTTP connection open on the t4g.2xlarge EC2 host; enough concurrent users under full Bedrock streaming can exhaust Node's connection pool. The `statement_timeout: 120s` cap on Steampipe (ADR-001) and the AgentCore Gateway timeouts bound the worst case.

  장시간 요청은 Node.js 커넥션을 점유한다. 60초짜리 AI 요청은 t4g.2xlarge EC2에서 HTTP 커넥션 하나를 계속 붙잡고 있으며, 동시에 스트리밍 중인 사용자가 충분히 많으면 Node 커넥션 풀이 고갈될 수 있다. Steampipe `statement_timeout: 120s`(ADR-001)와 AgentCore Gateway 타임아웃이 최악의 경우를 제한한다.

- **Debugging is harder than JSON.** The browser network tab shows an "ongoing" request with no body preview until completion; inspecting intermediate frames requires capturing the raw stream. The retained JSON non-streaming branch is used for `curl`-based debugging.

  디버깅이 JSON보다 어렵다. 브라우저 네트워크 탭은 완료 전까지 본문 프리뷰 없이 "진행 중" 상태만 보인다. 중간 프레임을 보려면 원시 스트림을 캡처해야 한다. 유지되는 JSON 비스트리밍 분기는 `curl` 기반 디버깅에 사용된다.

## References / 참고 자료

### Internal

- [ADR-002](002-ai-hybrid-routing.md): AI Hybrid Routing — the 11-route priority list whose progress frames are the primary payload of the `status` event.
- [ADR-009](009-alert-triggered-ai-diagnosis.md): Alert-Triggered AI Diagnosis — uses the same `SendFn` contract with `nullSend` while running in the background, preserving the option to attach an SSE surface later.
- [ADR-013](013-auto-collect-investigation-agents.md): Auto-Collect Investigation Agents — all seven collectors accept `SendFn` and emit per-phase `status` frames through the shared contract.
- `src/app/api/ai/route.ts`: Single HTTP SSE surface. `sseEvent()` helper, `ReadableStream` constructor, and event emitters (`status`, `chunk`, `done`, `error`).
- `src/lib/collectors/types.ts`: `SendFn = (event: string, data: any) => void` — shared contract.
- `src/lib/report-generator.ts`: Uses `SendFn` (defaults to `noop`) for diagnosis collection phases.
- `src/lib/alert-diagnosis.ts`: Uses `SendFn = nullSend` in background webhook path.
- `src/app/ai/page.tsx`: Client-side SSE consumer — `res.body.getReader()` + `TextDecoder`, `event:`/`data:` line-pair parser.
- `src/app/ai-diagnosis/page.tsx`: Uses short polling against `/api/report?action=status&id=…` (not SSE) because the report job persists to S3 and the UI only needs terminal status.
- [CLAUDE.md](../../CLAUDE.md): Root project context — AgentCore tool inference note, 11-route table, Next.js 14.2.35 basePath rule.

### External

- [Next.js 14 App Router Streaming](https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming) — `Response` + `ReadableStream` pattern.
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) — `event:` / `data:` frame format.
- [MDN: ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream) — streaming API used by the AI route.
- [Bedrock `InvokeModelWithResponseStreamCommand`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/InvokeModelWithResponseStreamCommand/) — source of `chunk` deltas forwarded into SSE.
