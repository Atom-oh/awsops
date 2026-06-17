# ADR-031: Runtime-Customizable Agents & Skills (Admin-Composed Agent Spaces + BYO-MCP) / 런타임 커스터마이즈 에이전트·스킬 (관리자 구성 Agent Space + BYO-MCP)

## Status / 상태

> **⚠️ PARTIALLY REVERSED (2026-06-11)** — owner decision via 3-AI consensus (kiro/codex/gemini; see `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`). **Phase 1 (custom-agent/skill catalog + resolver, LIVE) and Phase 2 (per-account Agent Spaces + tool-allowlist enforcement, deployed) STAND.** **Phase 3 (BYO-MCP external tool servers) and Phase 4 (mutating tools via the ADR-029 gate) are REVERSED/abandoned** — external-endpoint egress/SSRF/credential surface + agent-driven mutation are scope-creep a small team should not maintain; Phase 4 also depends on the now-reversed ADR-029/036. Phase 3/4 are NOT built; do-not-pursue.

Accepted (2026-06-09) / 채택 (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES; codex/gemini/kiro). 데이터-플레인 분리는 건전; mutating BYO-MCP는 Action Catalog/P2 경유, revocation fail-closed, BYO-MCP 하드닝·인젝션 가드·ADR-033 비용 통제 보완 (§Consensus Review Addenda 참조).

This ADR records the decision and its phased scope. Implementation detail (object model, Aurora schema, resolver, validation pipeline, acceptance criteria) lives in the companion spec `docs/superpowers/specs/2026-05-31-custom-agents-skills-design.md`.

이 ADR은 결정과 단계별 범위를 기록한다. 구현 상세(객체 모델, Aurora 스키마, 리졸버, 검증 파이프라인, 수용 기준)는 동반 스펙 `docs/superpowers/specs/2026-05-31-custom-agents-skills-design.md`에 있다.

## Context / 컨텍스트

AWS released two **frontier agents** — [AWS DevOps Agent](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent.html) and [AWS Security Agent](https://docs.aws.amazon.com/securityagent/latest/userguide/what-is.html) — whose customization model AWSops wants to adopt: operators add and compose agents and skills item-by-item through a console, scoped per environment, rather than shipping a fixed set in code. Three concrete primitives from the docs are load-bearing for this decision. (1) DevOps Agent registers **MCP servers at the account level** (Streamable HTTP with OAuth 2.0 / API key / **SigV4**), and each **Agent Space** — "a logical container that defines what the agent can access ... account configurations, third-party tool integrations, and access permissions" — then picks which tools it needs ([Connecting MCP Servers](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent-connecting-mcp-servers.html)). (2) DevOps Agent **skills** are "self-contained directories of Markdown instructions" that "guide the agent in using your custom MCP server tools," with the guidance to "allowlist only ... read-only MCP tools with read-only credentials" ([DevOps Agent Skills](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent-devops-agent-skills.html)). (3) Security Agent splits requirements into **Managed** (AWS-provided) and **Custom** (you define) tiers ([Manage security requirements](https://docs.aws.amazon.com/securityagent/latest/userguide/security-requirements.html)).

AWS는 두 개의 **프런티어 에이전트**([AWS DevOps Agent](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent.html), [AWS Security Agent](https://docs.aws.amazon.com/securityagent/latest/userguide/what-is.html))를 출시했고, AWSops는 그 커스터마이즈 모델을 차용하려 한다: 운영자가 콘솔에서 에이전트와 스킬을 **항목별로** 추가·구성하고 환경별로 스코핑하며, 고정된 세트를 코드에 박아 배포하지 않는다. 문서의 세 가지 구체 프리미티브가 이 결정의 토대다. (1) DevOps Agent는 **MCP 서버를 계정 수준에서 등록**(Streamable HTTP + OAuth 2.0 / API key / **SigV4**)하고, 각 **Agent Space**("에이전트가 접근할 수 있는 범위를 정의하는 논리적 컨테이너 ... 계정 구성, 서드파티 통합, 접근 권한")가 필요한 도구를 고른다([Connecting MCP Servers](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent-connecting-mcp-servers.html)). (2) DevOps Agent **스킬**은 "자체 완결적 마크다운 지시 디렉토리"로 "커스텀 MCP 도구 사용을 안내"하며, "읽기 전용 MCP 도구를 읽기 전용 자격 증명으로만 allowlist"하라고 권고한다([DevOps Agent Skills](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent-devops-agent-skills.html)). (3) Security Agent는 요구사항을 **Managed**(AWS 제공)와 **Custom**(직접 정의) 등급으로 나눈다([Manage security requirements](https://docs.aws.amazon.com/securityagent/latest/userguide/security-requirements.html)).

AWSops is architecturally close but operationally rigid. `agent/agent.py` holds a `SKILL_BASE` dictionary of role-specific prompts, the classifier in `src/app/api/ai/route.ts` selects 1–3 of 11 routes and synthesizes parallel gateway results (ADR-002, ADR-025), and the 8 role-based gateways expose 125 MCP tools (ADR-004). All of it is baked into the Docker image: changing a skill or adding a specialist route requires editing `agent.py`, rebuilding the arm64 image, and redeploying the AgentCore Runtime — and nothing varies per account. Notably, `agent.py` already speaks **SigV4 Streamable HTTP MCP** (`streamable_http_sigv4.py`) and already auto-discovers gateways, so the transport AWS requires for bring-your-own MCP (BYO-MCP) is already in place. ADR-030 also just introduced Aurora for durable application state.

AWSops는 구조적으로는 가깝지만 운영상 경직되어 있다. `agent/agent.py`는 역할별 프롬프트 `SKILL_BASE` 딕셔너리를 갖고, `src/app/api/ai/route.ts`의 분류기는 11개 라우트 중 1~3개를 골라 병렬 게이트웨이 결과를 통합하며(ADR-002, ADR-025), 8개 역할 기반 게이트웨이가 125개 MCP 도구를 노출한다(ADR-004). 이 모든 것이 Docker 이미지에 박혀 있어, 스킬 변경이나 전문 라우트 추가에 `agent.py` 수정·arm64 재빌드·Runtime 재배포가 필요하고 계정별 차이도 없다. 특히 `agent.py`는 이미 **SigV4 Streamable HTTP MCP**(`streamable_http_sigv4.py`)를 사용하고 게이트웨이를 자동 발견하므로, AWS가 BYO-MCP에 요구하는 전송 방식이 이미 갖춰져 있다. ADR-030은 또한 내구성 있는 애플리케이션 상태를 위해 Aurora를 막 도입했다.

The motivating requirement is precise: an admin should compose, from the AWSops dashboard at runtime, custom **agents** (specialist personas) and **skills** (reusable instruction packages) — including registering external MCP tool servers — scoped per account, without a rebuild. Because skills carry a tool allowlist and BYO-MCP introduces external endpoints, this also enlarges the privilege and egress surface and must be governed against the existing security ADRs (ADR-011 SSRF allowlist, ADR-023 admin model, ADR-029 mutating-action gate).

요구사항은 명확하다: 관리자가 런타임에 AWSops 대시보드에서 커스텀 **에이전트**(전문 페르소나)와 **스킬**(재사용 지시 패키지)을 — 외부 MCP 도구 서버 등록 포함 — 계정별로 구성하되 재빌드 없이 할 수 있어야 한다. 스킬은 도구 allowlist를 포함하고 BYO-MCP는 외부 엔드포인트를 들이므로, 권한·이그레스 표면이 커지며 기존 보안 ADR(ADR-011 SSRF allowlist, ADR-023 관리자 모델, ADR-029 변경 작업 게이트)에 맞춰 통제해야 한다.

## Options Considered / 고려한 대안

### Option 1: Aurora catalog + admin UI + per-request resolver (Aurora/S3 hybrid storage) — chosen / Aurora 카탈로그 + 관리자 UI + 요청별 리졸버 (Aurora/S3 하이브리드) — 채택

Skills and agents are reusable catalog objects (many-to-many) stored in Aurora; uploaded package artifacts (`references/`, `assets/`, bundles) go to S3 referenced by a content hash. An admin-gated dashboard does CRUD and composes a per-account **Agent Space** (ADR-008, ADR-023). At query time a **resolver** (`src/lib`) reads the effective Agent Space, the classifier selects a built-in or custom agent, and the resolver hands `agent.py` a fully **resolved spec** (persona + composed skill instructions + tool allowlist + BYO-MCP endpoints). `agent.py` stays **registry-agnostic** — it executes the spec, connecting to allowlisted gateways plus BYO-MCP via the existing SigV4 transport (OAuth/API-key added later). BYO-MCP servers register per account and expose an allowlistable, health-checked tool set.

스킬과 에이전트는 Aurora에 저장되는 재사용 카탈로그 객체(M:N)이며, 업로드된 패키지 아티팩트(`references/`, `assets/`, 번들)는 content hash로 참조되어 S3에 저장된다. 관리자 전용 대시보드가 CRUD와 계정별 **Agent Space** 구성을 담당한다(ADR-008, ADR-023). 질의 시 **리졸버**(`src/lib`)가 유효 Agent Space를 읽고, 분류기가 built-in 또는 custom 에이전트를 선택하며, 리졸버가 `agent.py`에 완전히 **해석된 스펙**(페르소나 + 합성 스킬 지시 + 도구 allowlist + BYO-MCP 엔드포인트)을 넘긴다. `agent.py`는 **registry-agnostic** — 스펙을 실행만 하며, 허용된 게이트웨이와 BYO-MCP에 기존 SigV4 전송으로 연결한다(OAuth/API-key는 추후). BYO-MCP 서버는 계정별 등록되어 allowlist·헬스체크된 도구 세트를 노출한다.

- **Pros / 장점**: Add/compose agents and skills at runtime, per account, with no Docker rebuild. The resolver being the single catalog reader makes `agent.py` registry-agnostic, which eliminates the "two delivery layers" state-inconsistency risk by design. Core prompts come from Aurora into the payload, so there is no per-request S3 fetch for the prompt (no cold-start on the hot path). Leverages Aurora (ADR-030) for many-to-many, audit, and versioning; reuses classifier (ADR-002/025), admin model (ADR-023), SSRF allowlist (ADR-011), SigV4 MCP transport, and the ADR-029 mutating gate. Mirrors AWS Agent Spaces and the Managed/Custom tiering.
- **Pros / 장점**: 런타임에 계정별로 에이전트·스킬 추가·구성, Docker 재빌드 없음. 리졸버가 카탈로그의 단일 독자라 `agent.py`가 registry-agnostic이 되어 "두 전달 계층" 상태 불일치 위험이 설계상 제거된다. 핵심 프롬프트는 Aurora→payload 경로라 프롬프트용 요청별 S3 페치가 없다(핫패스 콜드스타트 없음). Aurora(ADR-030)로 M:N·감사·버전 관리를 활용하고, 분류기(ADR-002/025)·관리자 모델(ADR-023)·SSRF allowlist(ADR-011)·SigV4 MCP 전송·ADR-029 변경 게이트를 재사용한다. AWS Agent Space 및 Managed/Custom 등급을 반영한다.
- **Cons / 단점**: Introduces a catalog schema, a resolver, an admin UI, a validation/integrity pipeline, and BYO-MCP connection management. BYO-MCP is a real egress/privilege surface needing endpoint allowlisting, credential custody, and signature verification (Phase 3). Per-account behavior drift complicates support reproduction, requiring traceability (Agent Space version + skill content hash in every response/log). Resolver cache and Aurora must stay coherent across multiple resolver instances.
- **Cons / 단점**: 카탈로그 스키마·리졸버·관리자 UI·검증/무결성 파이프라인·BYO-MCP 연결 관리를 도입한다. BYO-MCP는 엔드포인트 allowlist·자격 증명 관리·서명 검증(Phase 3)이 필요한 실질적 이그레스/권한 표면이다. 계정별 동작 드리프트는 지원 재현을 어렵게 해 추적성(모든 응답/로그에 Agent Space 버전 + 스킬 content hash)이 필요하다. 다중 리졸버 인스턴스 간 리졸버 캐시와 Aurora의 정합을 유지해야 한다.

### Option 2: S3 skill registry + `agent.py` progressive disclosure / S3 스킬 레지스트리 + `agent.py` 점진적 공개

Skills as `SKILL.md` packages synced to S3; `agent.py` loads name+description at startup and fetches the full body on match. (This was the initial ADR-031 draft.)

스킬을 S3에 동기화되는 `SKILL.md` 패키지로 두고, `agent.py`가 시작 시 name+description만 로드, 매칭 시 본문을 페치한다. (초기 ADR-031 초안.)

- **Pros / 장점**: Token-efficient at startup; skill packages are portable artifacts.
- **Pros / 장점**: 시작 시 토큰 효율적; 스킬 패키지가 이식 가능한 아티팩트.
- **Cons / 단점**: Runtime S3 fetch on match adds cold-start latency on Fargate. Both the Next.js classifier and `agent.py` read the registry, creating a two-brain state-inconsistency risk (a newly published skill selected by one but stale in the other) that demands EventBridge/webhook cache invalidation. Local development requires a LocalStack/registry pipeline, hurting DX. These are the exact concerns raised in external review; Option 1's resolver pattern avoids them.
- **Cons / 단점**: 매칭 시 런타임 S3 페치가 Fargate에서 콜드스타트 지연을 만든다. Next.js 분류기와 `agent.py`가 모두 레지스트리를 읽어 두뇌-2개 상태 불일치 위험(새 스킬을 한쪽은 선택, 다른 쪽은 낡은 캐시)이 생겨 EventBridge/webhook 캐시 무효화가 필요하다. 로컬 개발에 LocalStack/레지스트리 파이프라인이 필요해 DX가 나빠진다. 외부 리뷰가 제기한 우려 그대로이며, Option 1의 리졸버 패턴이 이를 회피한다.

### Option 3: config.json-only registry / config.json 전용 레지스트리

Store the whole catalog in `data/config.json` per account; `route.ts` assembles prompts and passes them in the payload.

전체 카탈로그를 계정별 `data/config.json`에 저장하고, `route.ts`가 프롬프트를 조립해 페이로드로 전달한다.

- **Pros / 장점**: Simplest operationally — pure config, no new infrastructure.
- **Pros / 장점**: 운영상 가장 단순 — 순수 설정, 신규 인프라 없음.
- **Cons / 단점**: No real many-to-many, weak audit/concurrency, prompt blobs bloat config and every payload, and no artifact storage for `references/`/`assets/`. Does not leverage the Aurora investment (ADR-030).
- **Cons / 단점**: 진정한 M:N 부재, 감사·동시성 취약, 프롬프트 덩어리가 config와 모든 payload를 부풀림, `references/`/`assets/` 아티팩트 저장 불가. Aurora 투자(ADR-030)를 활용하지 못함.

### Option 4: Status quo — hardcoded `SKILL_BASE` / 현 상태 — 하드코딩 `SKILL_BASE`

Keep editing `agent.py` and rebuilding for every change. Rejected baseline.

변경마다 `agent.py`를 고치고 재빌드. 기각 기준선.

- **Pros / 장점**: Zero new work or attack surface.
- **Pros / 장점**: 신규 작업·공격 표면 제로.
- **Cons / 단점**: Meets none of the motivating requirements (runtime customization, per-account variation, BYO-MCP).
- **Cons / 단점**: 동기가 된 요구(런타임 커스터마이즈, 계정별 변형, BYO-MCP) 어느 것도 충족하지 못함.

## Decision / 결정

Adopt **Option 1**. Skills and agents become reusable, admin-composed catalog objects (built-in vs custom tiers, mirroring AWS Managed/Custom); a per-account Agent Space (mirroring AWS Agent Spaces) declares what is enabled; a resolver builds the effective spec and hands it to a registry-agnostic `agent.py`; BYO-MCP servers register per account using the existing SigV4 Streamable HTTP transport.

**Option 1**을 채택한다. 스킬과 에이전트는 관리자가 구성하는 재사용 카탈로그 객체(built-in vs custom 등급, AWS Managed/Custom 반영)가 되고, 계정별 Agent Space(AWS Agent Space 반영)가 활성 항목을 선언하며, 리졸버가 유효 스펙을 만들어 registry-agnostic `agent.py`에 넘기고, BYO-MCP 서버는 기존 SigV4 Streamable HTTP 전송으로 계정별 등록된다.

Security is multi-layered, not single-control: server-side allowlist enforcement against a known tool catalog, the ADR-029 gate for any mutating tool, read-only by default, disabled-by-default authoring, SHA-256 integrity hashing of artifacts from Phase 1, and cosign/Sigstore signature verification from Phase 3 (when externally-sourced uploads are allowed; cosign key custody is the shared follow-up already noted in ADR-030). Every response and AgentCore stat records the Agent Space version, agent id, and each skill's content hash for traceability. A `SKILLS_SOURCE=local` dev mode hot-reloads `agent/skills/` and a local catalog, bypassing S3. EventBridge/pub-sub cache invalidation is intentionally excluded from v1 because the resolver is the single catalog reader (Aurora is the single source of truth with a short-TTL resolver cache).

보안은 단일 통제가 아닌 다층이다: 알려진 도구 카탈로그에 대한 서버측 allowlist 강제, 변경 도구의 ADR-029 게이트, 기본 읽기 전용, 기본 비활성 작성, Phase 1부터 아티팩트 SHA-256 무결성 해시, Phase 3부터 cosign/Sigstore 서명 검증(외부 출처 업로드 허용 시점; cosign 키 관리는 ADR-030에 이미 적힌 공통 후속 과제). 모든 응답과 AgentCore 통계는 추적성을 위해 Agent Space 버전·agent id·각 스킬 content hash를 기록한다. `SKILLS_SOURCE=local` 개발 모드는 `agent/skills/`와 로컬 카탈로그를 핫리로드하며 S3를 우회한다. EventBridge/pub-sub 캐시 무효화는 리졸버가 카탈로그의 단일 독자이므로 v1에서 의도적으로 제외한다(Aurora가 단일 진실원천, 짧은 TTL 리졸버 캐시).

Phased scope / 단계별 범위:

- **Phase 1** — Skill + Agent catalog (Aurora) + admin CRUD + resolver + classifier extension, bound to the existing 125 tools only. SHA-256 integrity, local hot-reload, and traceability logging are in scope from Phase 1. Built-in agents and `SKILL_BASE` are migrated into the catalog as read-only entries.
- **Phase 1** — 스킬 + 에이전트 카탈로그(Aurora) + 관리자 CRUD + 리졸버 + 분류기 확장, **기존 125개 도구에만** 바인딩. SHA-256 무결성·로컬 핫리로드·추적성 로깅을 Phase 1부터 포함. built-in 에이전트와 `SKILL_BASE`를 읽기 전용 항목으로 카탈로그에 이관.
- **Phase 2** — Per-account Agent Spaces: enablement + tool-allowlist scoping (ADR-008).
- **Phase 2** — 계정별 Agent Space: 활성화 + 도구 allowlist 스코핑(ADR-008).
- **Phase 3** — BYO-MCP registration (SigV4 first, then OAuth/API-key) + endpoint allowlist (ADR-011) + health checks + cosign signature verification for uploaded artifacts.
- **Phase 3** — BYO-MCP 등록(SigV4 우선, 이후 OAuth/API-key) + 엔드포인트 allowlist(ADR-011) + 헬스체크 + 업로드 아티팩트 cosign 서명 검증.
- **Phase 4 (gated)** — mutating tools routed through ADR-029.
- **Phase 4 (게이트)** — 변경 도구를 ADR-029 경유.

**Accepted (2026-06-09)** via the multi-AI consensus review (see Status header + §Consensus Review Addenda). *(Historical drafting note: this paragraph previously read "Status remains Proposed until Phase 1 scope is confirmed" — that condition was met and the ADR was accepted; the header/index Status is authoritative.)* Explicitly out of scope (YAGNI): learned/auto-tuned skills, per-user agents, cross-org skill marketplace, EventBridge pub-sub.

**Accepted (2026-06-09)** — 멀티AI 합의 리뷰로 채택(Status 헤더 + §Consensus Review Addenda 참조). *(이력 메모: 본 문단은 과거 "Phase 1 범위 확정 전까지 Proposed 유지"였으나 조건이 충족되어 채택됨 — 헤더/인덱스 Status가 권위.)* 명시적 범위 제외(YAGNI): 학습형/자동 튜닝 스킬, 사용자별 에이전트, 조직 간 스킬 마켓플레이스, EventBridge pub-sub.

## Consequences / 결과

### Positive / 긍정적

- Operators customize the AI per account at runtime — no Docker rebuild — turning AWSops from a fixed-tool assistant into a composable platform. / 운영자가 런타임에 계정별로 AI를 커스터마이즈 — Docker 재빌드 없음 — AWSops를 고정 도구 어시스턴트에서 조합형 플랫폼으로 전환.
- The resolver/registry-agnostic-`agent.py` split structurally removes the two-brain inconsistency and the hot-path cold-start that plagued the S3-registry alternative. / 리졸버 + registry-agnostic `agent.py` 분리가 S3 레지스트리 대안의 두뇌-2개 불일치와 핫패스 콜드스타트를 구조적으로 제거.
- Reuses Aurora (ADR-030), classifier (ADR-002/025), admin model (ADR-023), SSRF allowlist (ADR-011), SigV4 MCP transport, and the ADR-029 gate instead of new machinery. / Aurora(ADR-030)·분류기(ADR-002/025)·관리자 모델(ADR-023)·SSRF allowlist(ADR-011)·SigV4 MCP 전송·ADR-029 게이트를 재사용.
- Maps directly onto AWS Frontier Agent concepts (Agent Spaces, account-level MCP, Managed/Custom tiers), easing operator mental models and future interop. / AWS 프런티어 에이전트 개념(Agent Space, 계정 수준 MCP, Managed/Custom 등급)에 직접 매핑되어 운영자 멘탈 모델과 향후 상호운용을 돕는다.

### Negative / 부정적

- Adds catalog schema, resolver, admin UI, validation/integrity pipeline, and BYO-MCP connection management — meaningful new surface area. / 카탈로그 스키마·리졸버·관리자 UI·검증/무결성 파이프라인·BYO-MCP 연결 관리 추가 — 상당한 신규 표면.
- BYO-MCP is an egress/privilege vector requiring endpoint allowlisting, credential custody (Secrets Manager), and signature verification; mishandled, a malicious skill could attempt privilege escalation — mitigated by server-side allowlist + ADR-029 + integrity hashing, not by signing alone. / BYO-MCP는 엔드포인트 allowlist·자격 증명 관리(Secrets Manager)·서명 검증이 필요한 이그레스/권한 벡터; 잘못 다루면 악성 스킬이 권한 상승을 시도할 수 있어 서버측 allowlist + ADR-029 + 무결성 해시로 완화하며 서명 단독에 의존하지 않는다.
- Per-account drift requires disciplined traceability (Agent Space version + skill hash in logs) or support/debugging becomes hard. / 계정별 드리프트는 엄격한 추적성(로그에 Agent Space 버전 + 스킬 해시)을 요구하며 그렇지 않으면 지원·디버깅이 어려워진다.
- cosign adoption (Phase 3) depends on resolving key custody, the same open item ADR-030 flagged for Public ECR. / cosign 도입(Phase 3)은 키 관리 해결에 의존하며, ADR-030이 Public ECR용으로 표시한 동일 미해결 항목이다.

### Post-acceptance deviations / 채택 후 편차

- (none yet) / (아직 없음)

## References / 참고 자료

- [AWS DevOps Agent — Skills](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent-devops-agent-skills.html), [Connecting MCP Servers](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-capabilities-for-aws-devops-agent-connecting-mcp-servers.html), [About](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent.html)
- [AWS Security Agent — Manage security requirements](https://docs.aws.amazon.com/securityagent/latest/userguide/security-requirements.html), [What is](https://docs.aws.amazon.com/securityagent/latest/userguide/what-is.html)
- [Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws), [Kiro Agent Skills](https://kiro.dev/docs/skills/)
- Companion spec: `docs/superpowers/specs/2026-05-31-custom-agents-skills-design.md`
- Related ADRs: ADR-002 (AI hybrid routing), ADR-004 (Gateway role split), ADR-008 (Multi-account), ADR-011 (External datasource SSRF allowlist), ADR-021 (SSE streaming), ADR-023 (Admin role model), ADR-025 (Multi-route synthesis), ADR-029 (Mutating action gate), ADR-030 (ECS Fargate + Aurora; cosign key custody follow-up), ADR-032 (Event-triggered autonomous incident lifecycle — **consumes** this ADR's resolver/Agent Space for per-incident agent/skill resolution; this ADR remains unaware of triggers/lifecycle)
- Source touchpoints (v2, per Addendum #3): `agent/agent.py` (`SKILL_BASE`, `streamable_http_sigv4.py`), resolver/classifier in **`web/`** (not v1 `src/app/api/ai/route.ts`), catalog in **Aurora** + config in **SSM** (not `data/config.json`). The v1 paths (`src/app/api/ai/route.ts`, `data/config.json`) are historical.

## Consensus Review Addenda (2026-06-09) / 합의 리뷰 보완

Multi-AI consensus review (codex/gemini/kiro, Claude chair) → ACCEPT-WITH-CHANGES. The data-plane/resolver split is sound; resolved:

1. **Mutating BYO-MCP routes through governance** (codex CRITICAL): a custom MCP tool may **not** expose raw write capability that bypasses ADR-029/036. Every mutating tool is an **Action Catalog entry enqueued via P2** (AWS-resource → SSM/Change Manager, K8s/app-state → P2 code). BYO-MCP read tools are allowlisted; write tools must be catalog-bound. / mutating BYO-MCP는 Action Catalog/P2 경유만 — raw write 노출 금지.
2. **Revocation fails closed** (codex/kiro MAJOR): on multi-task Fargate, disabling a malicious skill/MCP endpoint must propagate **immediately across all resolver + AgentCore instances** (Aurora `LISTEN/NOTIFY` or a version-check on every resolve), not wait for the resolver TTL. Document the acceptable-staleness window (≤30s) for **non-security** changes only; security revocation is immediate. / 보안 revocation은 TTL 대기 없이 전 인스턴스 즉시 fail-closed.
3. **v2 paths/state** (codex MAJOR): resolver + touchpoints are `web/` + Aurora (schema migrations) + SSM config — not `src/`/`data/config.json` for v2. / v2 경로·상태 현행화.
4. **BYO-MCP hardening** (codex MAJOR, gemini MINOR): SigV4-only initially (reuse IAM trust); endpoint allowlist with DNS-rebinding/redirect handling; credentials in Secrets Manager with rotation; egress + per-account isolation. ADR-011 alone is insufficient. / BYO-MCP 하드닝: SigV4 우선·DNS rebinding 방어·Secrets Manager·egress 격리.
5. **Injection controls** (codex/gemini): custom Markdown, MCP tool descriptions, and tool results are **untrusted**; enforce a server-side tool allowlist **outside the model** + a static, non-overridable **system-prompt safeguard** (recommendation-only/safety boundary) + output validation. / 커스텀 콘텐츠·MCP 결과는 신뢰 불가 → 서버측 allowlist + 불변 시스템 프롬프트 가드 + 출력 검증.
6. **Phase-1 integrity scope** (codex MAJOR, kiro MINOR): Phase 1 = **admin-only uploads**; SHA-256 guards storage integrity/TOCTOU, **not** supply-chain. cosign/Sigstore is **Phase-3 opt-in hardening for external uploads**, not a hard blocker on Phase 1. / Phase-1은 관리자 업로드 한정·SHA-256은 무결성용; cosign은 Phase-3 외부 업로드용 선택 하드닝.
7. **Cost integration (ADR-033)** (codex/gemini MINOR): per-Agent-Space prompt-size/tool-count limits + token budgets + model-tier policy + telemetry; custom skills are checked against the `agentcore_enabled` flag and SSM-sourced config. / Agent Space별 비용 통제(ADR-033) + `agentcore_enabled` 검사.
