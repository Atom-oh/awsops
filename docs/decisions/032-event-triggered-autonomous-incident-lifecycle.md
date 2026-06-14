# ADR-032: Event-Triggered Autonomous Incident Lifecycle (Multi-Agent Lead/Sub) / 이벤트 트리거 자율 인시던트 라이프사이클 (멀티 에이전트 Lead/Sub)

## Status / 상태

> **⚠️ DOWNGRADED (2026-06-11)** — owner decision via 3-AI consensus (kiro/codex/gemini; see `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`). The **autonomous mitigation/action path is abandoned** (it routed through the now-**reversed** ADR-029/036). The read-only **Triage / multi-agent investigation / RCA** value is retained — **recommendation-only, NO mutation routing**. `incident_lifecycle_enabled` stays `false`; if ever enabled it is analysis-only (no mitigation execution, no ADR-029/036 calls). Phase 4 (prevention) is unaffected (recommend-only). Built flag-OFF; frozen.

Accepted (2026-06-09) / 채택 (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES; codex/gemini/kiro). 라이프사이클 상태머신은 건전; ADR-034/036 관계 추가, P2 백본에 실행 바인딩, look-back/타임아웃 설정값화, Lead 최소권한, 인젝션·알림스톰 통제 보완 (§Consensus Review Addenda 참조).

This ADR records the *control-plane* decision: when agents are triggered, what staged lifecycle they execute, and who authorizes mutations. It deliberately does **not** redefine *what* agents/skills exist or how they are composed — that is ADR-031's *data-plane* concern, which this ADR consumes.

이 ADR은 *컨트롤 플레인* 결정을 기록한다: 에이전트가 언제 트리거되고, 어떤 단계별 라이프사이클을 실행하며, 변경을 누가 승인하는가. *무엇*이 존재하고 어떻게 조합되는지는 의도적으로 **재정의하지 않는다** — 그것은 ADR-031의 *데이터 플레인* 관심사이며, 본 ADR은 그것을 소비한다.

## Context / 컨텍스트

AWS released the **AWS DevOps Agent**, whose operating model AWSops wants to mirror. The product spans two architecturally distinct concerns that happen to ship together: (1) a **composition model** — Agent Spaces, account-level MCP registration, Managed/Custom skill tiers — and (2) an **autonomous incident lifecycle** — webhook/event triggering, a Triage stage with a ~20-minute look-back correlation window, a multi-agent Lead/Sub investigation structure, root-cause + mitigation-plan generation, and a proactive-prevention feedback loop (reference: internal "AWS DevOps Agent — How It Works", which condenses the AWS userguide on [Autonomous incident response](https://docs.aws.amazon.com/devopsagent/latest/userguide/working-with-devops-agent-autonomous-incident-response.html) and [Incident Response](https://docs.aws.amazon.com/devopsagent/latest/userguide/devops-agent-incident-response.html)).

AWS는 **AWS DevOps Agent**를 출시했고, AWSops는 그 운영 모델을 차용하려 한다. 이 제품은 함께 출시되었을 뿐 구조적으로 구분되는 두 관심사를 아우른다: (1) **조합 모델** — Agent Space, 계정 수준 MCP 등록, Managed/Custom 스킬 등급 — 과 (2) **자율 인시던트 라이프사이클** — 웹훅/이벤트 트리거, ~20분 look-back 상관분석을 가진 Triage 단계, 멀티 에이전트 Lead/Sub 조사 구조, 근본 원인 + 완화 계획 생성, 사전 예방 피드백 루프(참조: 내부 "AWS DevOps Agent — How It Works", AWS userguide의 [Autonomous incident response](https://docs.aws.amazon.com/devopsagent/latest/userguide/working-with-devops-agent-autonomous-incident-response.html) · [Incident Response](https://docs.aws.amazon.com/devopsagent/latest/userguide/devops-agent-incident-response.html)를 압축).

**ADR-031 covers only concern (1).** It explicitly excludes EventBridge/pub-sub from v1 and mentions webhooks only as a *rejected* cache-invalidation mechanism. The trigger + lifecycle (concern 2) is therefore unaddressed by any current ADR — except for a partial, reactive predecessor: **ADR-009** (alert-triggered AI diagnosis) already runs a single-pass diagnosis with a correlation engine (`alert-correlation.ts`), entered via the HMAC-authenticated webhook of **ADR-022** (`alert-webhook/route.ts`).

**ADR-031은 관심사 (1)만 다룬다.** v1에서 EventBridge/pub-sub를 명시적으로 제외하며, 웹훅은 *기각된* 캐시 무효화 메커니즘으로만 언급된다. 따라서 트리거 + 라이프사이클(관심사 2)은 현재 어떤 ADR로도 다뤄지지 않는다 — 부분적·반응형 선행 결정만 존재한다: **ADR-009**(알림 트리거 AI 진단)는 상관분석 엔진(`alert-correlation.ts`)과 함께 단일 패스 진단을 실행하며, **ADR-022**(`alert-webhook/route.ts`)의 HMAC 인증 웹훅으로 진입한다.

The motivating question — *"should the DevOps-Agent-style trigger + lifecycle be folded into ADR-031, since both are features of the same product?"* — was cross-reviewed by three independent assistants (codex, gemini, kiro-cli). All three reached the same verdict: **split**, and all three labeled "same product ⇒ same ADR" a **category error** — a product boundary is not an architecture-decision boundary; ADRs group by *decision surface*, not by vendor packaging. The two concerns sit on orthogonal axes (data-plane composition vs. control-plane orchestration) and must be acceptable/supersedable independently: one could adopt the skill catalog without autonomous triggers, or vice versa.

동기가 된 질문 — *"DevOps Agent식 트리거 + 라이프사이클을 같은 제품의 기능이니 ADR-031에 묶어야 하나?"* — 은 세 독립 어시스턴트(codex, gemini, kiro-cli)에게 교차 검토를 받았다. 셋 모두 동일 결론에 도달했다: **분리**, 그리고 셋 모두 "같은 제품 ⇒ 같은 ADR"을 **범주 오류**로 규정했다 — 제품 경계는 아키텍처 결정 경계가 아니며, ADR은 *결정 표면(decision surface)* 으로 묶이지 벤더 패키징으로 묶이지 않는다. 두 관심사는 직교 축(데이터 플레인 조합 vs 컨트롤 플레인 오케스트레이션)에 있고 독립적으로 채택·승계 가능해야 한다: 스킬 카탈로그만 채택하고 자율 트리거는 안 할 수도, 그 반대도 가능하다.

## Options Considered / 고려한 대안

### Option 1: Separate ADR-032 control-plane lifecycle, built on ADR-031/030 — chosen / 별도 ADR-032 컨트롤 플레인 라이프사이클, ADR-031/030 위에 구축 — 채택

A new ADR defines an event-triggered, staged, multi-agent incident lifecycle as a distinct decision. It **consumes** ADR-031 (the Lead agent asks the resolver which Sub-agents/skills apply to this incident), **supersedes** ADR-009's single-pass flow (while retaining its correlation engine as the Triage component), and **extends** ADR-022 (ingress), ADR-029 (mitigation gate), and ADR-030 (Aurora state + Fargate execution). ADR-031 remains entirely unaware of triggers or lifecycle phases.

새 ADR이 이벤트 트리거·단계별·멀티 에이전트 인시던트 라이프사이클을 독립 결정으로 정의한다. ADR-031을 **소비**(Lead 에이전트가 리졸버에 "이 인시던트엔 어떤 Sub-agent/스킬"인지 질의)하고, ADR-009의 단일 패스 플로우를 **승계**(상관분석 엔진은 Triage 컴포넌트로 보존)하며, ADR-022(인그레스)·ADR-029(완화 게이트)·ADR-030(Aurora 상태 + Fargate 실행)을 **확장**한다. ADR-031은 트리거·라이프사이클 단계를 전혀 인지하지 않는다.

- **Pros / 장점**: Each ADR stays single-purpose and independently reviewable, accept-able, and supersedable. The data-plane/control-plane split mirrors the resolver-vs-`agent.py` separation ADR-031 already established. Reuses every adjacent investment (009 correlation, 022 auth, 029 gate, 030 Aurora/Fargate, 031 composition) instead of new machinery. Maps 1:1 onto the DevOps Agent's dual-console model (Agent Space config vs. incident operations).
- **Cons / 단점**: Two ADRs (031 + 032) must be read together to see the full "DevOps Agent" picture; requires disciplined cross-references. A genuinely new surface — lifecycle state machine, Lead/Sub orchestration, incident persistence — still has to be designed and secured regardless of where it is documented.

### Option 2: Fold the lifecycle into ADR-031 (one "DevOps Agent" ADR) — rejected / 라이프사이클을 ADR-031에 통합 (단일 "DevOps Agent" ADR) — 기각

Expand ADR-031 to also cover triggering, the staged lifecycle, and Lead/Sub orchestration, on the rationale that both are features of the same AWS product.

ADR-031을 확장해 트리거·단계별 라이프사이클·Lead/Sub 오케스트레이션까지 담는다. 근거는 둘 다 같은 AWS 제품의 기능이라는 것.

- **Pros / 장점**: One document tells the whole "DevOps Agent" story; fewer ADRs to navigate.
- **Cons / 단점**: Category error (product boundary ≠ decision boundary), flagged independently by all three cross-reviewers. Creates a "God ADR" coupling two orthogonal axes — changing the event bus would force revisiting the agent-catalog schema, and vice versa. Directly contradicts ADR-031's own explicit v1 exclusion of EventBridge/pub-sub, forcing a reinterpretation of a stated boundary and making review harder. Prevents adopting composition without autonomy (or the reverse).

### Option 3: Extend ADR-009 in place, no new ADR — rejected / ADR-009를 제자리 확장, 신규 ADR 없음 — 기각

Rewrite ADR-009 to absorb the multi-stage lifecycle and multi-agent structure.

ADR-009를 다단계 라이프사이클·멀티 에이전트 구조까지 흡수하도록 재작성한다.

- **Pros / 장점**: No new ADR number; keeps the incident-response lineage in one file.
- **Cons / 단점**: ADR-009 is **Accepted**; silently expanding an accepted decision to a substantially larger scope erases the decision history and the trade-offs originally accepted. The lifecycle pulls in 031/029/030 dependencies that did not exist when 009 was accepted. Cleaner to supersede 009 from a new ADR than to mutate it.

### Option 4: Status quo — ADR-009 reactive single-pass diagnosis — rejected baseline / 현 상태 — ADR-009 반응형 단일 패스 진단 — 기각 기준선

Keep the existing alert→diagnose→notify flow; no autonomous lifecycle.

기존 알림→진단→알림 플로우 유지; 자율 라이프사이클 없음.

- **Pros / 장점**: Zero new work or surface.
- **Cons / 단점**: Meets none of the motivating requirements (autonomous triage correlation, staged investigation, mitigation planning, prevention loop, per-incident agent composition).

## Decision / 결정

Adopt **Option 1**: a new **ADR-032 "Event-Triggered Autonomous Incident Lifecycle"** as a control-plane decision layered on the existing stack. Relationships:

**Option 1**을 채택한다: 기존 스택 위에 얹는 컨트롤 플레인 결정으로 신규 **ADR-032 "이벤트 트리거 자율 인시던트 라이프사이클"** 을 둔다. 관계:

| Relationship | ADR | Meaning |
|---|---|---|
| **supersedes** | ADR-009 | The 5-stage lifecycle replaces 009's single-pass diagnosis. 009's correlation engine (`alert-correlation.ts`) is **retained** as the Triage look-back component, not discarded. |
| **extends** | ADR-022 | Reuses HMAC-authenticated webhook ingress (`alert-webhook/route.ts`) as the trigger entry point; adds the correlation look-back semantics on top. |
| **extends** | ADR-029 | The Mitigation phase routes any mutating action through the mutating-action gate (recommendation-only by default; human/coding-agent executes). |
| **extends** | ADR-030 | Incident state, investigation timeline, and prevention-feedback records persist in Aurora; the Lead agent and Sub-agents execute on Fargate. |
| **consumes** | ADR-031 | The Lead agent calls the ADR-031 resolver to materialize which Sub-agents/skills/tools participate in a given incident, scoped by the per-account Agent Space. ADR-031 has no knowledge of triggers or lifecycle phases. |

Lifecycle stages (mirroring the DevOps Agent model) / 라이프사이클 단계 (DevOps Agent 모델 반영):

1. **Trigger** — webhook (CloudWatch SNS / Alertmanager / Grafana / PagerDuty-style / Generic, via ADR-022) or manual free-text entry. / 웹훅(ADR-022 경유) 또는 수동 자유 텍스트 입력.
2. **Triage** — ~20-min look-back correlation against active investigations → `New` / `Linked` / `Skipped`; dedup and noise reduction. Reuses ADR-009's correlation engine. / 활성 조사 대비 ~20분 look-back 상관분석 → `New`/`Linked`/`Skipped`; 중복·노이즈 감소. ADR-009 상관분석 엔진 재사용.
3. **Investigation** — Lead agent (incident commander) plans and delegates to Sub-agents (logs / metrics / code-change / deploy-history) with compacted-context handoff; each returns compressed findings. Sub-agent rosters resolved via ADR-031. / Lead 에이전트(인시던트 커맨더)가 계획을 세우고 Sub-agent(로그/메트릭/코드변경/배포이력)에 압축 컨텍스트로 위임; 각자 압축 결과 반환. Sub-agent 구성은 ADR-031로 해석.
4. **Root Cause & ~~Mitigation Plan~~** — RCA only. ⛔ **The mitigation/remediation half is ABANDONED (2026-06-11 downgrade)** — it routed through the now-reversed ADR-029/036; this stage is **RCA + recommendation text only, no plan execution, no ADR-029/036 calls**. (Original, as history: "a plan with pre-validate/remediation/post-validate steps, recommendation-only, mutating steps gated by ADR-029.") / RCA만. **완화/조치 절반은 폐기(2026-06-11)** — reversed 029/036 경유였음; 본 단계는 RCA+권고 텍스트만, 실행·029/036 호출 없음.
5. **Proactive Prevention** — analyze investigation history to emit prevention recommendations (observability / testing gaps / code / infra). / 조사 이력 분석으로 예방 권고(옵저버빌리티/테스트 격차/코드/인프라) 생성.

Traceability: every investigation record stores the trigger source, Triage decision, the resolved Agent Space version + agent id + skill content hashes (consistent with ADR-031's traceability requirement), and a per-stage timeline in Aurora.

추적성: 모든 조사 기록은 트리거 소스, Triage 결정, 해석된 Agent Space 버전 + agent id + 스킬 content hash(ADR-031 추적성 요건과 일관), Aurora의 단계별 타임라인을 저장한다.

Phased scope / 단계별 범위:

- **Phase 1** — Trigger + Triage: promote ADR-009's flow into a durable, correlated lifecycle record (Aurora). Webhook ingress (ADR-022) + look-back correlation + `New`/`Linked`/`Skipped`. Single-agent investigation retained (no Lead/Sub yet). / 트리거 + Triage: ADR-009 플로우를 내구성 있는 상관 라이프사이클 기록(Aurora)으로 승격. 웹훅 인그레스(ADR-022) + look-back 상관 + `New`/`Linked`/`Skipped`. 단일 에이전트 조사 유지(아직 Lead/Sub 없음).
- **Phase 2** — Lead/Sub multi-agent investigation with compacted-context handoff; Sub-agent roster resolved via ADR-031 Agent Space. / 압축 컨텍스트 위임을 갖춘 Lead/Sub 멀티 에이전트 조사; Sub-agent 구성은 ADR-031 Agent Space로 해석.
- **Phase 3** — ⛔ **ABANDONED (2026-06-11 downgrade)** — Mitigation Plan generation routed through the reversed ADR-029/036. Not pursued; the lifecycle stops at RCA + recommendation (no mitigation execution). / **폐기(2026-06-11)** — 완화 계획 생성은 reversed 029/036 경유였으므로 미추진; 라이프사이클은 RCA+권고에서 멈춘다.
- **Phase 4** — Proactive Prevention feedback loop from investigation history. / 조사 이력 기반 사전 예방 피드백 루프.

**Deployment dependency (not just ADR status) / 배포 의존성 (ADR 상태가 아님)**: Phase 1 persists incident state in Aurora, so it is blocked on ADR-030's *implementation progress* — specifically ADR-030 **Phase 1 (Aurora provisioning + schema migration)** must be **deployed**, not merely Accepted. "ADR Accepted" ≠ "infrastructure deployed"; Phase 1 of this ADR cannot start until the Aurora `incident_lifecycle` tables physically exist. (Phases 2–3 depended on ADR-029/031 — both REVERSED 2026-06-11; the mitigation path is abandoned, only read-only Triage/RCA remains.)

**배포 의존성**: Phase 1은 인시던트 상태를 Aurora에 영속하므로 ADR-030의 *구현 진행*에 묶인다 — 구체적으로 ADR-030 **Phase 1(Aurora 프로비저닝 + 스키마 이전)** 이 단지 Accepted가 아니라 **배포 완료**되어야 한다. "ADR Accepted" ≠ "인프라 배포됨"; Aurora `incident_lifecycle` 테이블이 물리적으로 존재하기 전엔 본 ADR Phase 1을 시작할 수 없다. (Phase 2–3은 ADR-029/031에 의존했으나 둘 다 2026-06-11 REVERSED — mitigation 경로는 폐기, read-only Triage/RCA만 유지.)

### State machine failure semantics / 상태 머신 실패 시맨틱

The lifecycle is a persisted state machine, not a happy-path script. The following are **binding requirements from Phase 1**, not deferred:

라이프사이클은 해피패스 스크립트가 아니라 영속 상태 머신이다. 다음은 **Phase 1부터의 구속 요건**이며 미루지 않는다:

- **Triage dedup races / Triage 중복 레이스**: concurrent alerts that both pass the look-back window must not both create a `New` incident. Use an Aurora **conditional write / row-level lock** (e.g., a unique correlation key + `INSERT ... ON CONFLICT`, or `SELECT ... FOR UPDATE` over the active-investigation set) so exactly one wins and the rest resolve to `Linked`. / look-back를 동시에 통과한 알림이 둘 다 `New`를 만들지 않도록 Aurora **조건부 쓰기/행 잠금**(고유 상관 키 + `INSERT ... ON CONFLICT`, 또는 활성 조사 집합에 `SELECT ... FOR UPDATE`)으로 정확히 하나만 승리, 나머지는 `Linked`로 해소.
- **Per-stage checkpointing + watchdog / 단계별 체크포인트 + 워치독**: each stage transition is committed to Aurora with a `last_checkpoint_at` timestamp. A watchdog (e.g., 10-min stage timeout) transitions a stuck incident to a terminal `stalled` state and notifies, so a crashed Lead agent never leaves an incident `investigating` forever. / 각 단계 전이를 `last_checkpoint_at`과 함께 Aurora에 커밋. 워치독(예: 단계 10분 타임아웃)이 멈춘 인시던트를 종료 상태 `stalled`로 전이·알림하여, 크래시된 Lead 에이전트가 인시던트를 영원히 `investigating`에 두지 않게 한다.
- **At-least-once + idempotency keys / 최소 1회 + 멱등 키**: webhook/trigger delivery is at-least-once; every stage carries a stage-level idempotency key so a retried Investigation resumes from the last checkpoint rather than spawning duplicate Sub-agents or re-running mitigation. / 웹훅/트리거 전달은 최소 1회이며, 각 단계가 단계 수준 멱등 키를 가져 재시도된 Investigation이 Sub-agent 중복 생성이나 완화 재실행 대신 마지막 체크포인트에서 재개한다.
- **Fargate task replacement / Fargate 태스크 교체**: an active investigation survives task replacement by resuming from the last Aurora checkpoint; in-flight Sub-agent work past the last checkpoint is re-executed (idempotent), not silently lost. / 활성 조사는 마지막 Aurora 체크포인트에서 재개하여 태스크 교체를 견딘다; 마지막 체크포인트 이후 진행 중이던 Sub-agent 작업은 (멱등하게) 재실행되며 조용히 소실되지 않는다.

**Accepted (2026-06-09)** via the multi-AI consensus review (see Status header + §Consensus Review Addenda). ADR-029 and ADR-031 are **also Accepted (2026-06-09)**, so the Phase 2–3 dependencies are unblocked at the ADR level (deployment still depends on ADR-030/037 Aurora being provisioned, per the Deployment-dependency note above). *(Historical drafting note: this paragraph previously read "remains Proposed … until ADR-029 (currently Proposed) and ADR-031 (currently Proposed) advance"; all three were accepted the same day — the header/index Status is authoritative.)* Explicitly out of scope (YAGNI): learned/auto-tuned investigation skills, autonomous (un-gated) remediation execution, cross-account incident federation beyond the existing multi-account model (ADR-008).

**Accepted (2026-06-09)** — 멀티AI 합의 리뷰로 채택. ADR-029·ADR-031도 **2026-06-09 Accepted**라 Phase 2–3 의존성은 ADR 수준에서 해제(배포는 위 배포-의존성 노트대로 ADR-030/037 Aurora 프로비저닝에 여전히 의존). *(이력 메모: 본 문단은 과거 "ADR-029(현재 Proposed)·ADR-031(현재 Proposed) 진전 전까지 Proposed"였으나 셋 다 같은 날 채택됨 — 헤더/인덱스 Status가 권위.)* 명시적 범위 제외(YAGNI): 학습형/자동 튜닝 조사 스킬, 자율(게이트 없는) 조치 실행, 기존 멀티 어카운트 모델(ADR-008)을 넘는 교차 계정 인시던트 페더레이션.

## Consequences / 결과

### Positive / 긍정적

- Single-purpose ADRs: 031 stays the composition platform, 032 is the autonomy loop on top — each independently reviewable and supersedable. / 단일 목적 ADR: 031은 조합 플랫폼, 032는 그 위 자율 루프 — 각자 독립 검토·승계 가능.
- Reuses 009 (correlation), 022 (auth), 029 (gate), 030 (Aurora/Fargate), 031 (composition) instead of new machinery. / 신규 기계장치 대신 009·022·029·030·031 재사용.
- Maps cleanly onto the DevOps Agent dual-console model (config plane = 031 Agent Space; ops plane = 032 lifecycle), easing operator mental models and future interop. / DevOps Agent 듀얼 콘솔(설정면=031 Agent Space, 운영면=032 라이프사이클)에 깔끔히 매핑되어 운영자 멘탈 모델·향후 상호운용을 돕는다.
- Durable incident state in Aurora enables the prevention feedback loop and post-incident forensics. / Aurora의 내구성 인시던트 상태가 예방 피드백 루프와 사후 포렌식을 가능케 한다.

### Negative / 부정적

- Adds a real control-plane surface: a lifecycle state machine, Lead/Sub orchestration, and incident persistence schema. Failure modes (retry/crash idempotency, Triage races, watchdog) are specified in **State machine failure semantics** above and are binding from Phase 1 — but they remain non-trivial to implement correctly. / 실질적 컨트롤 플레인 표면 추가: 라이프사이클 상태 머신, Lead/Sub 오케스트레이션, 인시던트 영속 스키마. 실패 모드(재시도/크래시 멱등성, Triage 레이스, 워치독)는 위 **상태 머신 실패 시맨틱**에 명시되어 Phase 1부터 구속되나, 올바른 구현 자체는 여전히 까다롭다.
- The full "DevOps Agent" picture now spans two ADRs (031 + 032); without disciplined cross-references the relationship can drift. / 전체 "DevOps Agent" 그림이 두 ADR(031+032)에 걸쳐 — 엄격한 상호 참조 없으면 관계가 어긋날 수 있다.
- Superseding an Accepted ADR (009) requires care: the correlation engine must be carried forward, not silently dropped, or existing alert-diagnosis behavior regresses. / Accepted ADR(009) 승계는 주의 필요: 상관분석 엔진을 조용히 버리지 말고 이월해야 하며, 아니면 기존 알림 진단 동작이 퇴행한다.
- Autonomous investigation amplifies blast radius if Sub-agents touch mutating tools; mitigated by recommendation-only default + ADR-029 gate, but the surface is non-zero. / 자율 조사는 Sub-agent가 변경 도구를 건드리면 폭발 반경을 키운다; 권고 전용 기본 + ADR-029 게이트로 완화하나 표면은 0이 아니다.

### Post-acceptance deviations / 채택 후 편차

- (none yet) / (아직 없음)

## References / 참고 자료

- Internal: "AWS DevOps Agent — How It Works" (translation/summary of AWS userguide + blogs) / 내부: "AWS DevOps Agent — How It Works"
- [AWS DevOps Agent — Autonomous incident response](https://docs.aws.amazon.com/devopsagent/latest/userguide/working-with-devops-agent-autonomous-incident-response.html), [Incident Response](https://docs.aws.amazon.com/devopsagent/latest/userguide/devops-agent-incident-response.html), [About](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent.html)
- [From AI agent prototype to product (AWS DevOps Blog, 2026-01-15)](https://aws.amazon.com/blogs/devops/from-ai-agent-prototype-to-product-lessons-from-building-aws-devops-agent/) — Lead/Sub multi-agent rationale
- Cross-review consensus (codex / gemini / kiro-cli, 2026-05-31): unanimous "split into ADR-032"; unanimous "same product ⇒ same ADR is a category error".
- Related ADRs: ADR-008 (Multi-account), ADR-009 (alert-triggered AI diagnosis — **superseded by this ADR**, correlation engine retained), ADR-022 (alert webhook HMAC auth — **extended**), ADR-029 (mutating-action gate — **extended**), ADR-030 (ECS Fargate + Aurora — **extended**), ADR-031 (Runtime-Customizable Agents & Skills — **consumed** for per-incident agent/skill resolution).
- Source touchpoints: the v1 correlation/diagnosis logic (`src/lib/alert-correlation.ts`, `alert-diagnosis.ts`, `alert-knowledge.ts`, `src/app/api/alert-webhook/route.ts`) is the **carried-forward reference**; the v2 implementation lands in **`web/`** + the **P2 worker backbone** + **Aurora `incident_lifecycle`** tables (Addendum #3/#8, via `terraform/v2/foundation/data/schema.sql`), with config in **SSM**, not `data/config.json`.

## Consensus Review Addenda (2026-06-09) / 합의 리뷰 보완

Multi-AI consensus review (codex/gemini/kiro, Claude chair) → ACCEPT-WITH-CHANGES. The lifecycle/idempotency design is sound; resolved:

1. **Relationship table += ADR-034 (Accepted)** (codex MAJOR): the lifecycle's RCA **output** is owned by ADR-034 — OpsCenter/Incident Manager/Slack routing, the observability-write control subset, the feedback-loop marker, and best-effort non-blocking behavior. 032 consumes 034 for output rather than leaving it implicit. / RCA 출력은 ADR-034가 소유.
2. **Relationship table += ADR-036 (Accepted)** (codex/kiro MAJOR): the **Mitigation phase executes through ADR-036's hybrid substrate** — P2 Action-Catalog front door, AWS-resource actions via SSM Automation/Change Manager, K8s/app-state via P2 Lambda/Fargate. The Lead agent **never executes mutations directly**. / Mitigation은 036 하이브리드 substrate로 실행, Lead 직접 실행 금지.
3. **Execution bound to the P2 backbone** (codex MAJOR, gemini MINOR): webhook/manual triggers **enqueue async work through P2** (ADR-030); the `incident_lifecycle` tables are **domain state, not a second orchestration spine**; the watchdog/checkpointing rely on P2/Step Functions, not bare Lambda/Fargate. / 실행은 P2 백본에 바인딩; incident_lifecycle은 도메인 상태(별도 오케스트레이션 아님).
4. **Configurable windows** (gemini/kiro MAJOR): the ~20-min Triage look-back and the ~10-min per-stage timeout are **configurable** (SSM/Aurora: `INCIDENT_CORRELATION_WINDOW_MINUTES`, per-stage timeouts) — illustrative, not hardcoded constants, to avoid false "stalled" transitions on long Investigations. / look-back·스테이지 타임아웃은 설정값(상수 아님).
5. **Lead-agent least privilege + define "coding-agent"** (gemini/kiro): the Lead (Incident Commander) cannot invoke mutating tools directly — it **delegates to a Sub-agent bound to a mutating skill, gated by ADR-029/036**. "human/coding-agent executes" = a **human-approved CI/automation actor that still transits the ADR-029 plan→execute flow** (not a bypass of recommendation-only). / Lead는 변경 직접 실행 불가·위임만; "coding-agent"는 029 plan→execute를 거치는 사람-승인 액터.
6. **Prompt-injection** (codex MAJOR): alert payloads are attacker-controlled — they must not influence tool permissions, the agent roster, or mitigation approval; RCA text uses **structured input isolation + sanity-check before the ADR-034 write-back**. / 알림 페이로드 인젝션 방어(권한·로스터·승인 불가침).
7. **Alert-storm controls** (codex MAJOR): max concurrent RCA/investigations, Sub-agent fan-out limits, queue backpressure/DLQ, retry budgets, and ADR-033 token-budget + severity gating. / 알림 스톰 통제(동시 RCA 캡·fan-out 한계·DLQ·ADR-033 예산).
8. **Schema ownership** (codex MINOR): new Aurora tables land via `terraform/v2/foundation/data/schema.sql` + `schema_migrations` (normal Terraform plan/validation). / 신규 테이블은 terraform schema.sql + schema_migrations 경유.
