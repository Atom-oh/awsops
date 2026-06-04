# ADR-035: K8sGPT Hybrid — In-Cluster Kubernetes Diagnosis via MCP into AgentCore / K8sGPT 하이브리드 — MCP로 AgentCore에 통합하는 인클러스터 K8s 진단

## Status: Proposed (2026-06-04) / 상태: 제안 (2026-06-04)

> Scoped to **P3** (consumes the P1f AgentCore fabric + P2 worker backbone + P1e EKS onboarding). Decision support: `~/Documents/K8sGPT_vs_AWSops_Research_20260604/` (deep-research, 22 sources). Depends on ADR-029 (Accepted? — Proposed) for the remediation tier; diagnosis-only scope ships without it.

## Context / 컨텍스트

AWSops v2 is broad across AWS (IAM, cost, network, RDS, CIS, multi-account) but **shallow on in-cluster Kubernetes object diagnosis**: v2 currently ships read-only EKS onboarding only (Access Entry + AmazonEKSViewPolicy, see `reference/07-eks.md`), and the cluster-query agent experience is itself a P3 item. Meanwhile K8sGPT — a CNCF Sandbox project — already provides mature, rule-based in-cluster analyzers (Pod, Service, PVC, Ingress, Node, webhooks, …) that triage Kubernetes failures and explain them in plain language, with an LLM used only to narrate analyzer findings (detection is deterministic; the model does not do multi-step reasoning).

The two are **complementary layers, not competitors**: K8sGPT is an L1 in-cluster diagnostic *sensor*; AWSops is the L2/L3 cross-service *orchestration and action* platform. AWS's own EKS reference architecture treats K8sGPT as a diagnosis input feeding a Bedrock orchestrator, with remediation handled by a separate (ArgoCD) agent. For an **all-in-Kubernetes** estate the value of K8sGPT's depth rises while AWSops' breadth advantage narrows — yet governed remediation, alert correlation/RCA, multi-account, and AWS-substrate visibility (IRSA/IAM, security groups, dependency RDS/ELB — none of which K8sGPT can see) remain AWSops-only. K8sGPT also now ships **MCP v2** support (v0.4.27, Dec 2025), making it directly consumable as a tool by an MCP-native orchestrator — and AWSops' AgentCore gateways are MCP-native.

The decision: how should AWSops obtain deep in-cluster K8s diagnosis — build it, adopt a tool, or integrate one — and how should that interact with AWSops' orchestration, model strategy, and remediation governance?

(AWSops v2는 AWS 전반에 넓지만 **인클러스터 K8s 객체 진단이 얕다** — 현재 read-only EKS 온보딩만 제공하고 클러스터 조회 에이전트 UI 자체가 P3다. 반면 K8sGPT(CNCF Sandbox)는 성숙한 규칙 기반 analyzer로 K8s 장애를 분류·설명하며, LLM은 analyzer 결과를 평문으로 *설명*만 한다(탐지는 결정적). 둘은 경쟁이 아니라 **계층**이다: K8sGPT=인클러스터 진단 센서(L1), AWSops=교차서비스 오케스트레이션·실행(L2/L3). AWS의 EKS 레퍼런스 아키텍처도 K8sGPT를 진단 입력으로, 조치는 별도 에이전트로 둔다. **all-in-K8s** 환경에선 K8sGPT 깊이의 가치가 커지지만, 거버넌스된 조치·알림 상관·멀티계정·AWS 기반 가시성(IRSA/IAM·SG·의존 RDS 등 K8sGPT가 못 보는 것)은 여전히 AWSops 고유다. 또한 K8sGPT는 v0.4.27부터 **MCP v2**를 지원해 MCP 네이티브 오케스트레이터의 도구로 바로 쓸 수 있고, AWSops AgentCore 게이트웨이가 MCP 네이티브다.)

## Options Considered / 고려한 대안

### Option 1: Hybrid — K8sGPT operator as L1 sensor, integrated via MCP into AgentCore; remediation stays in AWSops — chosen / 채택
- **Pros**: Mature in-cluster K8s diagnosis **immediately**, closing the v2 gap without waiting for native analyzers; K8sGPT stays a *component* (read-only sensor) while AWSops adds AWS-substrate context, cross-checking, governed remediation, alert lifecycle, and a single UI; reuses existing seams (MCP gateways, P2 worker backbone, P1e EKS access); portable across clusters; matches AWS's documented reference pattern. / 인클러스터 진단을 **즉시** 확보(네이티브 analyzer 대기 불필요), K8sGPT는 read-only 센서 컴포넌트로 두고 AWSops가 AWS 기반 컨텍스트·교차검증·거버넌스 조치·알림 라이프사이클·단일 UI를 더함. 기존 연결점(MCP 게이트웨이·P2 워커·P1e EKS) 재사용, 이식성, AWS 레퍼런스 패턴 일치.
- **Cons**: One more component per cluster (K8sGPT operator) to deploy/upgrade; K8sGPT is CNCF Sandbox maturity with documented LLM-reliability caveats (vague/occasionally unsafe suggestions, answer inconsistency, partial anonymization); MCP integration + result normalization is net-new work; couples to K8sGPT's evolving CRD/MCP schema. / 클러스터마다 컴포넌트 1개 추가 운영, K8sGPT는 Sandbox 성숙도 + LLM 신뢰성 한계(모호/위험 제안·일관성·부분 익명화), MCP 통합·결과 정규화 신규 작업, K8sGPT 스키마 변화에 결합.

### Option 2: Build native in-cluster K8s analyzers inside AWSops / AWSops에 네이티브 analyzer 자체 구현
- **Pros**: Full control, no external dependency, unified data model. / 완전한 제어, 외부 의존 없음, 통합 데이터 모델.
- **Cons**: Reinvents a mature CNCF analyzer library (multi-year head start) for no differentiating value; large sustained maintenance; slowest time-to-value. Rejected — effort better spent on the cross-cutting/action layers K8sGPT structurally cannot provide. / 성숙한 CNCF analyzer를 차별성 없이 재발명(수년 격차), 유지보수 과중, 가장 느린 가치 실현. 기각 — K8sGPT가 구조적으로 못 하는 교차/조치 계층에 노력을 쓰는 게 낫다.

### Option 3: Adopt K8sGPT only (skip AWSops K8s depth) / K8sGPT만 채택
- **Pros**: Fastest, lightest for pure cluster triage. / 순수 클러스터 분류엔 가장 빠르고 가벼움.
- **Cons**: No AWS-substrate visibility, no governed remediation, no alert correlation/RCA/write-back, no multi-account, no single pane — i.e. drops AWSops' entire reason to exist. Even all-in-K8s estates retain an AWS substrate K8sGPT can't see. Rejected. / AWS 기반 가시성·거버넌스 조치·알림 상관/RCA·멀티계정·단일 화면 전부 상실 = AWSops 존재 이유 포기. all-in-K8s라도 K8sGPT가 못 보는 AWS 기반은 남음. 기각.

### Option 4: HolmesGPT (agentic) instead of K8sGPT / K8sGPT 대신 HolmesGPT
- **Pros**: Agentic ReAct investigation across 30+ toolsets, can open remediation PRs — closer to "investigator." / 30+ 툴셋 에이전트형 조사, 조치 PR 가능.
- **Cons**: Overlaps AWSops' own AgentCore orchestrator role rather than complementing it; heavier; we already own the agentic/investigation layer. K8sGPT's narrow read-only sensor role is the cleaner fit *under* our orchestrator. (Revisit if our orchestrator proves insufficient.) / AWSops AgentCore 오케스트레이터 역할과 겹침(보완 아님), 더 무거움, 에이전트 계층은 우리가 이미 보유. K8sGPT의 좁은 read-only 센서가 우리 오케스트레이터 *아래* 깔리기에 더 깔끔. (우리 오케스트레이터가 부족하면 재검토.)

## Decision / 결정

Adopt **Option 1 (Hybrid)**. K8sGPT is integrated as a **read-only in-cluster diagnostic sensor under AWSops' AgentCore orchestrator**, never as an autonomous actor.

(**Option 1(하이브리드)** 채택. K8sGPT를 **AWSops AgentCore 오케스트레이터 아래의 read-only 인클러스터 진단 센서**로 통합하며, 자율 행위자로 쓰지 않는다.)

Binding rules / 구속 규칙:

| # | Rule | Rationale |
|---|------|-----------|
| 1 | **Deploy the K8sGPT operator per onboarded EKS cluster** (continuous analyzer scans → `Result` CRDs + Prometheus metrics), reusing the P1e `awsops-v2-task` access entry path. | In-cluster depth without a native rebuild. |
| 2 | **Model = Claude Haiku 4.5 on Amazon Bedrock** for K8sGPT's explain step (in-region, e.g. `global.anthropic.claude-haiku-4-5-…`); the orchestrator uses Sonnet 4.6 (or higher) for cross-domain investigation. | The explain task is bounded narration → Haiku tier per ADR-033/ADR-016 cost strategy; deep reasoning stays at the orchestrator. **Do not** use OpenAI GPT-5.5/Codex here — K8sGPT's `amazonbedrock` backend targets Claude/Nova via Converse, not the OpenAI Responses API. |
| 3 | **Integrate via MCP**: register K8sGPT (MCP v2, ≥ v0.4.27) as an MCP target consumed by AWSops' AgentCore container/orchestrator. K8sGPT output is treated as a **hypothesis to verify**, not an answer. | MCP-native on both sides; counters K8sGPT's inconsistency/false-negatives by cross-checking against AWSops infra state. |
| 4 | **Remediation stays in the AWSops worker backbone** (ADR-029 mutating-action framework + ADR-030/P2 SQS→SFN→Lambda/Fargate, host-scoped, risk-gated, kill-switchable). **K8sGPT auto-remediation is NOT enabled.** | K8sGPT auto-remediation is opt-in Sandbox maturity; keep "propose" (K8sGPT/orchestrator) separate from "execute" (governed workers) per the AWS reference pattern and the observe→suggest→act maturity ramp. |
| 5 | **Privacy posture**: enable `--anonymize`; for sensitive/regulated clusters require an in-region Bedrock model or a fully local model, never a public LLM. Note anonymization does **not** mask Event/Describe/ContainerStatus. | K8sGPT anonymization is partial; cluster data crosses an LLM boundary. |
| 6 | **AWSops adds the cross-boundary layer** K8sGPT cannot: correlate a K8sGPT finding with IRSA/IAM, security groups, dependency RDS/ELB, cost, and multi-account context; surface in the existing alert pipeline (ADR-032 lifecycle, ADR-034 write-back) and UI. | This is the durable differentiator; do not race K8sGPT on analyzer depth. |

### Phasing / 단계

| Phase | Scope | Done when |
|-------|-------|-----------|
| H1 | K8sGPT operator Helm-deployed to one onboarded EKS cluster (Bedrock Haiku 4.5 backend, `--anonymize`); `Result` CRDs + Prometheus metrics flowing. | `k8sgpt analyze --explain` returns real findings; metrics scraped. |
| H2 | MCP integration: AgentCore container consumes K8sGPT MCP tool; container-section agent enriches findings with AWS-substrate context; surfaced read-only in UI. | A K8sGPT finding appears in AWSops enriched with ≥1 AWS-substrate cross-reference. |
| H3 | Lifecycle wiring: K8sGPT-sourced incidents flow into ADR-032 correlation/RCA + ADR-034 write-back; remediation proposals routed to the ADR-029 worker tier (gated, no auto-apply). | An end-to-end "K8s finding → enriched RCA → gated remediation proposal" path demonstrated. |

## Consequences / 영향

### Positive / 긍정적
- Closes AWSops v2's in-cluster K8s gap **now**, with mature analyzers, instead of waiting for a native build. / 네이티브 구현 대기 없이 v2의 인클러스터 K8s 공백을 즉시 해소.
- Clean layering: K8sGPT (depth, read-only sensor) + AWSops (breadth, orchestration, governed action) — each does what it is best at. / 깔끔한 계층 분리 — 각자 잘하는 일.
- Cost/quality tiering falls out naturally (Haiku for L1 narration, Sonnet for L2 investigation), consistent with ADR-016/ADR-033. / 비용·품질 계층화가 자연스럽게 정리(ADR-016/033 일치).
- Portable and AWS-pattern-aligned; especially strong for all-in-K8s estates. / 이식성 + AWS 패턴 정합, all-in-K8s에 특히 강함.

### Negative / 부정적
- Operational surface: a K8sGPT operator per cluster to deploy, RBAC, upgrade, and monitor. / 클러스터마다 operator 운영·RBAC·업그레이드·모니터링 부담.
- Inherited LLM-reliability risk (vague/occasionally unsafe suggestions, answer inconsistency) — mitigated by treating output as a hypothesis, cross-checking, and never auto-applying. / LLM 신뢰성 위험 — 가설로 취급·교차검증·자동적용 금지로 완화.
- Coupling to a CNCF **Sandbox**-maturity project's CRD/MCP schema; version skew risk. / Sandbox 성숙도 프로젝트의 스키마에 결합, 버전 드리프트 위험.
- Privacy: cluster data crosses an LLM boundary with only partial anonymization — constrains backend choice for regulated clusters. / 부분 익명화로 클러스터 데이터가 LLM 경계를 넘음 — 규제 클러스터의 백엔드 선택 제약.
- Net-new MCP integration + result-normalization work (H2/H3). / MCP 통합·결과 정규화 신규 작업.

### Post-acceptance deviations / 채택 후 편차
- None yet (Proposed). / 아직 없음 (제안 상태).

## References / 참고
- Decision support (deep-research, 2026-06-04): `~/Documents/K8sGPT_vs_AWSops_Research_20260604/K8sGPT_vs_AWSops_Research.md` (22 sources; Findings 4–6 + Recommendations).
- ADR-029 (Mutating Action Framework — remediation gating), ADR-030 (ECS Fargate + Aurora; P2 worker backbone), ADR-031 (Runtime-Customizable Agents), ADR-032 (Event-Triggered Autonomous Incident Lifecycle), ADR-034 (Alert Auto-RCA Write-Back), ADR-016 (Bedrock Model Selection), ADR-033 (AIOps LLM Cost Optimization).
- Component reference: `docs/superpowers/reference/05-agentcore.md`, `06-workers.md`, `07-eks.md`.
- K8sGPT: GitHub `k8sgpt-ai/k8sgpt`, docs `docs.k8sgpt.ai`, CNCF project page; AWS — "Use K8sGPT and Amazon Bedrock…" and "Automate Amazon EKS troubleshooting using an Amazon Bedrock agentic workflow."
