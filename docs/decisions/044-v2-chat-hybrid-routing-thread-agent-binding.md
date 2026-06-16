# ADR-044: v2 Chat Multi-Domain Routing — Hybrid (single-route + ADR-025 cross-domain auto-synthesis) + Thread/Agent Binding / v2 챗 멀티-도메인 라우팅 — 하이브리드(단일 라우트 + ADR-025 교차도메인 자동합성) + Thread/Agent 바인딩

## Status / 상태

Accepted (2026-06-16) / 채택 (2026-06-16) — owner decision after a multi-AI contradiction panel (kiro-cli/Opus 4.8 + antigravity/Gemini 3.1 Pro; codex unavailable this run — engine 404) cross-checked against the ADR texts by Claude (chair). The panel found the v2 chat multi-domain behavior was **never decided**: ADR-025 (auto-synthesis) and ADR-038 (single-route + manual switch chips) mandate opposite UX, and the companion spec (`docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md` §9.5, line 226) explicitly left it as "confirm whether v2 chat reuses ADR-025 fan-out or defers it." This ADR resolves that.

**Reconciles** A1 (025↔038 routing conflict) and A2 (thread↔agent binding undefined + picker-pin/switch-chip deadlock). **Supersedes ADR-025 for v2** (the v1 record is retained as history). **Amends ADR-038** (routing-priority ladder + switch-chip semantics).

본 ADR은 멀티-AI 모순 패널이 찾은 두 결함을 정합화한다: (A1) ADR-025(자동 합성)와 ADR-038(단일 라우트 + 수동 전환칩)이 정반대 UX를 지시하고 스펙 §9.5가 이를 미해결로 남김; (A2) thread↔agent 바인딩 미정의 + picker 핀이 전환칩을 무력화하는 데드락. **v2에 대해 ADR-025를 대체**하고 **ADR-038을 개정**한다.

## Context / 컨텍스트

The panel found three concrete problems, all at the document level (not implementation):

1. **Opposite cross-domain UX, both Accepted.**
   - ADR-025 §Decision: *"When `routes.length > 1`, the streaming handler fans out with `Promise.allSettled` ... Surviving results enter `synthesizeResponsesStreaming()`, which issues a second Bedrock call ... The merged answer streams to the client as SSE `chunk` events, identical to single-route flow."* — i.e. **silent auto-handoff**: a cross-domain question is answered by several agents merged into one answer, transparently.
   - ADR-038 §Decision #3: *"Top-1 자동 라우팅 + 2·3위 전환칩."* — i.e. only the top-1 gateway is called; the user must **click a switch chip** to consult another agent. ADR-038 never references ADR-025.
   - Companion spec §9.5 (line 226): *"Two distinct multi-domain paths must not be conflated ... confirm whether v2 chat reuses ADR-025 fan-out or defers it."* — left unresolved.

   The product intent (the originating concern) is the ADR-025 behavior: the assistant should **route automatically**, not tell the operator to go pick a different agent.

2. **Thread ↔ Agent binding undefined.** No ADR or spec states whether a chat thread (the Claude-app-style conversation list) is bound to one agent for its lifetime, or whether routing is per-turn. When the user switches agents mid-conversation (chip or picker), what happens to the thread, its context, and ADR-018 memory isolation is undefined.

3. **Picker-pin vs switch-chip deadlock.** Spec §10 (lines 245-246): a picker selection *"IS an explicit pin = highest precedence (pin > custom > classifier) ... not overridden by a transition-chip re-send."* So pinning an agent via the picker makes ADR-038's core cross-domain UX (the switch chips) inoperative for that turn — the two UX mechanisms contradict.

세 결함 모두 구현이 아닌 **문서 단계의 모순**이다.

## Decision / 결정

### 1. Hybrid routing — Option C (chosen) / 하이브리드 라우팅

`classifyRoute(prompt, pinned)` returns a **ranked route set with confidence**, not a single section:

- **Clear single-domain query** (one dominant route above the confidence threshold): route to that **single gateway** via the ADR-038 fast-path (regex → Haiku classifier). **Unchanged from today.**
- **Cross-domain query detected** (≥2 routes above threshold, capped at 3 — ADR-025's `.slice(0,3)`): fan out with `Promise.allSettled` and **auto-synthesize** the survivors via `synthesizeResponsesStreaming()` (ADR-025 mechanism), streaming one merged answer. **No user action — the handoff is automatic and transparent.**
- **Switch chips are retained but demoted** from the primary cross-domain mechanism to a **secondary manual aid**: they let the operator pull in a domain the synthesis did not cover, or re-ask under a single specific agent. They are no longer how cross-domain questions get answered.

명확 단일-도메인 = 단일 게이트웨이(현행 ADR-038); 교차-도메인 감지 = ADR-025 fan-out + 자동합성(사용자 개입 없음); 전환칩은 보조 수단으로 잔존.

### 2. Routing-priority ladder (amends ADR-038 §Decision #2) / 라우팅 우선순위 (ADR-038 개정)

```
explicit pin (picker / pin chip)
  > custom agent (ADR-031 routingKeywords)
  > Agent Space active filter (ADR-031 / ADR-039 — a disabled agent is never selectable)
  > classifier { single-route (regex > llm)  |  multi-route fan-out + synthesis }
  > active-section fallback (never the inactive `ops`)
```

The Agent Space active filter is inserted explicitly (the panel found ADR-038's ladder stopped at `pin > custom` and never integrated Agent Space scoping). Selecting (via picker) an agent disabled in the Agent Space returns an honest "agent disabled" message, not a silent fallback.

### 3. Picker-pin vs switch-chip — deadlock resolved / 데드락 해소

- A **picker selection pins the chosen agent for the current turn only** (and subsequent turns until changed), recorded in `chat_messages.meta`.
- A **switch-chip click CLEARS any active pin and re-routes** to the chip's target. The chip is a deliberate user override and therefore must win over a stale pin. (This reverses spec §10's "not overridden by a transition-chip re-send.")
- This removes the deadlock: the user is never stuck with a pinned agent they cannot leave via the UI.

### 4. Thread ↔ Agent binding / Thread-Agent 바인딩

- **A chat thread is agent-agnostic; routing is per-turn.** A thread is a conversation container, not an agent session. The thread persists across route/agent changes; switching agents mid-thread does **not** fork a new thread or drop context.
- **ADR-018 memory isolation is keyed on `userId` + `accountId` (+ thread), NOT on agent.** A single thread may legitimately involve several gateways across turns (single-domain turn → network; next turn → multi-domain synthesis); no per-agent memory partition is introduced.
- The currently-pinned agent (if any) and the route(s) used for each turn are surfaced on the existing ADR-021 `done` / ADR-038 `meta` SSE event — no new event frame.

### 5. Three multi-agent models delineated / 세 멀티-에이전트 모델 경계 명시

| Model | Owner ADR | When | Mechanism |
|---|---|---|---|
| **Chat cross-domain** | **ADR-044 (this) + ADR-025 mechanism** | Interactive chat, multi-domain query | Parallel 1–3 route fan-out + Bedrock synthesis, per turn |
| **Incident federation** | **ADR-032** (P4) | Event/alarm-triggered incident lifecycle | Lead/Sub over Step Functions Map, read-only Sub-agents |
| **External integration** | **ADR-039** | Agent reads/writes external SaaS | Single MCP egress substrate, governed |

**Boundary / handoff:** chat is synchronous and per-turn (ADR-025); incident is asynchronous and orchestrated (ADR-032). A chat conversation that needs an incident is **escalated explicitly** (a user/agent action that opens an incident via ADR-032), never silently promoted. These models do not compete for the same turn.

### 6. Gating / 게이트

- Single-route hybrid is already LIVE (`hybrid_routing_enabled`, ADR-038, gate PASSED 96.9%).
- **Multi-route fan-out + synthesis re-activation** ships behind a sub-flag and must pass a multi-domain golden-set (set-overlap scoring, per ADR-025 §Consequences) before activation. Until then, multi-domain queries degrade to the current single-route + chips behavior (no regression).

## Consequences / 결과

### Positive / 긍정적
- The originating concern is fixed: cross-domain questions get **one automatically-synthesized answer**; the assistant no longer tells the operator to go switch agents.
- The picker/chip deadlock is removed; thread↔agent binding is defined (agent-agnostic, per-turn routing), giving the Claude-app conversation model a coherent mental model.
- The three multi-agent models (chat / incident / integration) are delineated with explicit boundaries — closing the spec §9.5 "must not be conflated" warning.
- Reuses the ADR-025 mechanism already designed and tested in v1 — no new synthesis engine.

### Negative / 부정적
- Multi-domain turns pay ADR-025's cost: a second Bedrock synthesis call (~+400ms p50, up to +4096 output tokens) on top of the parallel gateway calls. Bounded by the 3-route cap + the sub-flag gate.
- The classifier must emit a **ranked multi-route set** (not a single section) — a change to ADR-038's `classifyRoute` output shape; golden-set must score set overlap, not exact match (ADR-025 §Consequences carries this caveat forward).
- Switch chips now have a narrower, secondary role; the UI must communicate that cross-domain is automatic (avoid implying the user must click).

### Relationship to other ADRs / 다른 ADR 관계
- **Supersedes ADR-025 for v2** — the v1 `src/app/api/ai/route.ts` record is retained as history; the *mechanism* (parallel fan-out + `synthesizeResponsesStreaming`) is carried forward into the v2 path under this ADR.
- **Amends ADR-038** — routing-priority ladder (Agent Space filter added) + switch-chip semantics (chip clears pin) + classifier output shape (ranked multi-route). ADR-038's regex/Haiku/caching decisions are otherwise unchanged.
- **Delineates from ADR-032** (incident federation, P4) and **ADR-039** (external integration) — distinct models, explicit boundaries.
- Consumes **ADR-018** (memory isolation — confirmed agent-agnostic), **ADR-021** (SSE `done` frame), **ADR-031** (custom agents + Agent Space), **ADR-033** (token budget — multi-route cost counts per route).

## References / 참고 자료
- Multi-AI panel (this review): kiro-cli/Opus 4.8 + antigravity/Gemini 3.1 Pro; codex unavailable (engine 404).
- Superseded for v2: **ADR-025**. Amended: **ADR-038**. Companion spec §9.5 (line 226), §10 (lines 245-246): `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md`.
- Mechanism source: ADR-025 `Promise.allSettled` + `synthesizeResponsesStreaming()`.
