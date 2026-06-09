# ADR-035: K8sGPT Hybrid — In-Cluster Kubernetes Diagnosis via MCP into AgentCore / K8sGPT 하이브리드 — MCP로 AgentCore에 통합하는 인클러스터 K8s 진단

## Status: Accepted (2026-06-09) / 상태: 채택 (2026-06-09)

> Consensus-reviewed 2026-06-09 (co-agent panel: kiro·codex·gemini, model-diverse). **Verdict: ACCEPT-WITH-CHANGES** — Option 1 (Hybrid) endorsed unanimously; the panel's refinements are folded into the binding rules below (Rule 5 strengthened; Rules 7–11 added) and the Phasing table. See *Consensus review* under Consequences. / 2026-06-09 멀티AI 합의 리뷰(만장일치 ACCEPT-WITH-CHANGES) — Option 1 채택 확정, 보강 사항을 Rule 5 강화 + Rule 7~11 추가 + Phasing에 반영.

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
| 2 | **Model = Claude Haiku 4.5 on Amazon Bedrock** for the explain/narration step (in-region `global.anthropic.claude-haiku-4-5-…`); the orchestrator uses Sonnet 4.6+ for cross-domain investigation. **⚠️ H0-amended (see Post-acceptance):** the narration runs in **AWSops' AgentCore**, NOT K8sGPT's `--explain`/`amazonbedrock` backend — that backend (v0.4.33) uses InvokeModel + a stale allow-list with **no Haiku 4.5 and no ap-northeast-2**. K8sGPT runs **deterministic-only**. | Bounded narration → Haiku tier (ADR-033/016); deep reasoning at the orchestrator. Relocating narration to AWSops keeps Haiku 4.5 in-region + structurally enforces Rule 8. |
| 3 | **Integrate via MCP**: register K8sGPT (MCP v2, ≥ v0.4.27) as an MCP target consumed by AWSops' AgentCore container/orchestrator. K8sGPT output is treated as a **hypothesis to verify**, not an answer. | MCP-native on both sides; counters K8sGPT's inconsistency/false-negatives by cross-checking against AWSops infra state. |
| 4 | **Remediation stays in the AWSops worker backbone** (ADR-029 mutating-action framework + ADR-030/P2 SQS→SFN→Lambda/Fargate, host-scoped, risk-gated, kill-switchable). **K8sGPT auto-remediation is NOT enabled.** | K8sGPT auto-remediation is opt-in Sandbox maturity; keep "propose" (K8sGPT/orchestrator) separate from "execute" (governed workers) per the AWS reference pattern and the observe→suggest→act maturity ramp. |
| 5 | **Privacy + backend lock (strengthened by consensus)**: K8sGPT's `ai.backend` **MUST be `amazonbedrock` in-region — no external/public LLM endpoint is permitted in any environment** (not just regulated clusters); `--anonymize` is **defense-in-depth, not the primary control**. Anonymization does **not** mask Event/Describe/ContainerStatus/ConfigMap values/env-var names/image URIs. | Partial anonymization + cluster data crossing an LLM boundary → the hard control is keeping the boundary inside AWS (Bedrock), not the masking. |
| 6 | **AWSops adds the cross-boundary layer** K8sGPT cannot: correlate a K8sGPT finding with IRSA/IAM, security groups, dependency RDS/ELB, cost, and multi-account context; surface in the existing alert pipeline (ADR-032 lifecycle, ADR-034 write-back) and UI. | This is the durable differentiator; do not race K8sGPT on analyzer depth. |
| 7 | **MCP tool contract = the stable abstraction (Sandbox exit strategy)**: pin the K8sGPT operator version, put a **versioned adapter layer** between K8sGPT's native output and our MCP tool schema, and gate operator upgrades behind a CI schema-compatibility test. The MCP tool's input/output contract — not K8sGPT's internals — is the durable interface; if K8sGPT is archived/diverges, swap the analyzer behind the same contract. | K8sGPT is CNCF **Sandbox** (≈30% 3-yr archival rate, breaking minor changes). Insulate AgentCore from upstream schema/version skew. |
| 8 | **MCP response separates fact from hypothesis**: the tool returns deterministic `analyzer_result` (which analyzer fired, on which resource — high confidence) **distinctly from** `llm_explanation` (the Haiku narration — a hypothesis). On any conflict with AWSops' own deterministic cluster/AWS data, **the deterministic data wins**; the LLM explanation is supplementary context only, surfaced in the UI labelled "AI hypothesis". | Counters the ~8–15% explain-step error rate; "verify, don't trust" at the schema level. |
| 9 | **Per-cluster operator is least-privilege + fail-safe**: deploy one operator per onboarded cluster with a **read-only ClusterRole (get/list/watch only; create/update/patch/delete explicitly denied)** and the K8sGPT **`--fix`/auto-remediation disabled at the operator config level** (defense-in-depth, not merely "not called"). The MCP tool exposes `last_scan_timestamp`; a stale (>5 min) or down operator **degrades gracefully** — the Container gateway's deterministic tools keep working without K8sGPT. | Sandbox-maturity + RBAC blast-radius + reliability: no single point of failure for cluster visibility. |
| 10 | **Define the network/transport path**: K8sGPT MCP server ↔ AgentCore (ECS Fargate, VPC) reachability is explicit (private path — internal LB / VPC Lattice / SSE), and the in-cluster operator → Bedrock egress uses a VPC endpoint (or NAT) — never the public internet for cluster data. | Fargate-in-mgmt-VPC ↔ EKS-in-cluster-VPC + the Rule 5 backend-lock both require a defined private transport. |
| 11 | **Cost cap + version matrix**: configurable scan interval + issue **de-duplication** (do not re-`--explain` an unchanged finding) + a **monthly Bedrock budget alarm**; document a supported K8s-version × K8sGPT-version matrix tested in CI. | Haiku × clusters × scan-freq is non-trivial at fleet scale (~$430/mo @ 10 clusters/5-min/20 issues est.); analyzers are version-sensitive. |

### Phasing / 단계

| Phase | Scope | Done when |
|-------|-------|-----------|
| H0 (POC gate, ~1wk) | Validate the three unknowns before committing: (a) analyzer behaviour on the target K8s version, (b) the AI explain/backend path, (c) MCP round-trip. | **✅ DONE 2026-06-09 (no-mutation CLI spike) — see Post-acceptance.** (a) PASS (45 findings on K8s 1.36); (b) FAIL-as-specified → **re-scoped**: K8sGPT deterministic-only, narration in AWSops AgentCore (Haiku 4.5 in-region); (c) MCP coupled to the AI backend → use the deterministic `Result` path. Gate = **GO** with the refinement. |
| H1 | K8sGPT operator Helm-deployed to one onboarded EKS cluster (Bedrock Haiku 4.5 backend, `--anonymize`, read-only RBAC + `--fix` off per Rule 9); `Result` CRDs + Prometheus metrics flowing. | `k8sgpt analyze --explain` returns real findings; metrics scraped; `last_scan_timestamp` exposed. |
| H2 | MCP integration: AgentCore container consumes K8sGPT MCP tool (fact/hypothesis-separated per Rule 8, via the versioned adapter per Rule 7); container-section agent enriches findings with AWS-substrate context; surfaced read-only in UI. If >5 clusters are in scope, fleet/multi-cluster operator management is pulled in here. | A K8sGPT finding appears in AWSops enriched with ≥1 AWS-substrate cross-reference; multi-cluster disambiguation works. |
| H3a | Remediation wiring: K8sGPT-sourced incidents flow into ADR-032 correlation/RCA + ADR-034 write-back; remediation **proposals** routed to the ADR-029 worker tier (gated, no auto-apply). | An end-to-end "K8s finding → enriched RCA → gated remediation proposal" path demonstrated. |
| H3b (research spike) | Accuracy feedback loop: thumbs-up/down on hypotheses logged to Aurora; periodic accuracy audit (K8sGPT diagnosis vs incident-postmortem RCA). | A feedback signal is captured and a first accuracy-audit report is produced. |

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

### Consensus review (2026-06-09) / 합의 리뷰
Multi-AI panel (co-agent, model-diverse): **kiro** (auto), **codex** (gpt-5.5), **gemini** (default). Quorum 3/3. **Unanimous verdict: ACCEPT-WITH-CHANGES** — Option 1 (Hybrid sensor-via-MCP) endorsed by all three over build-native / K8sGPT-only / HolmesGPT. Folded-in changes (raw agreement ≥2, chair-verified against this ADR):
- **3/3** — strengthen privacy to a hard `amazonbedrock`-in-region backend lock (→ Rule 5); `--anonymize` is defense-in-depth only.
- **3/3** — treat the MCP tool contract as the stable abstraction + versioned adapter + pinned version (CNCF Sandbox exit strategy) (→ Rule 7).
- **3/3** — separate deterministic `analyzer_result` from `llm_explanation` hypothesis; deterministic data wins on conflict (→ Rule 8).
- **2/3** — formalize per-cluster read-only RBAC + `--fix` off at config + stale-scan health + graceful degradation (→ Rule 9).
- **2/3** — define the Fargate↔EKS MCP transport + in-cluster→Bedrock egress path (→ Rule 10).
- **2/3** — cost cap (scan interval/dedup/budget alarm) + K8s×K8sGPT version matrix (→ Rule 11).
- Dissent/unique (kiro): confidence labelling + feedback loop + H0 POC gate + H3 split (→ Phasing). gemini: SSE/VPC-Lattice transport + Converse-API signature check.

### Post-acceptance deviations / 채택 후 편차

**H0 POC result (2026-06-09)** — no-mutation spike: K8sGPT CLI v0.4.33 run read-only against the onboarded `fsi-demo-cluster` (K8s **1.36**) via the validated task-role/STS token path (no operator deployed to the shared cluster). Findings vs the three unknowns:
- **(a) Analyzers — ✅ PASS.** Deterministic analyzers run cleanly on K8s 1.36 (only a benign `v1 Endpoints` deprecation warning) and produce **real, useful, structured findings** — **45 problems / 43 `Result` objects** (`kind,name,error,details,parentObject`), incl. a genuine `otel-collector` DaemonSet 5/8-ready + crash-loop and a ClickHouse termination. `--anonymize` works. `analyze --output json` (no AI) is **backend-independent** — this is the integration artifact AWSops consumes.
- **(b) `amazonbedrock` explain backend — ✗ FAIL as specified (Rule 2).** k8sgpt v0.4.33's `amazonbedrock` backend uses **InvokeModel** with a **stale hardcoded model+region allow-list**: **no Claude Haiku 4.5**, newest Claude = Sonnet 4 / legacy Haiku 3; **`ap-northeast-2` is not in its region list** (only us-east-1/us-west-2/ap-southeast-1/ap-northeast-1). Every attempt (Haiku 4.5 → "model not supported"; Haiku 3 / Sonnet 4 → 404 legacy/activation) failed. **→ ADR Rule 2 (Haiku 4.5 via the K8sGPT backend) + the in-region part of Rule 5 are NOT viable with the current release.**
- **(c) MCP server — ⚠️ PARTIAL.** `k8sgpt serve --mcp --mcp-http --mcp-port 8089` exists (v2), but **refuses to start without a valid AI backend** → coupled to the broken (b). The deterministic CLI/`Result`-CRD path needs no backend.

**Refinement (amends Rules 2/5, strengthens Rule 8):** the Hybrid decision (Option 1) **stands** — K8sGPT is a valuable deterministic in-cluster sensor — but **do NOT use K8sGPT's `--explain`/`amazonbedrock` backend.** Run K8sGPT **deterministic-only** (`analyze --output json` / `Result` CRDs) and do the **LLM narration in AWSops' AgentCore (Container agent) with Haiku 4.5 in-region (ap-northeast-2)** via our existing Bedrock. This keeps the Rule 2 model intent (Haiku 4.5) and the Rule 5 in-region guarantee, **moves the LLM boundary into AWSops** (better privacy + no k8sgpt-Bedrock coupling), and **structurally enforces Rule 8** (K8sGPT = `analyzer_result` fact; AWSops = `llm_explanation` hypothesis). Alternative if k8sgpt's own MCP/explain is later wanted: front Bedrock with an OpenAI-compatible proxy (LiteLLM / Bedrock Access Gateway) exposing Haiku 4.5 in ap-northeast-2 and point k8sgpt's `openai`/`localai` `--baseurl` at it (heavier — a proxy per integration). **H1 consumes the deterministic `Result` (CRD/JSON); the narration is AWSops-owned.** H0 gate: **GO** (with the above refinement).

## References / 참고
- Decision support (deep-research, 2026-06-04): `~/Documents/K8sGPT_vs_AWSops_Research_20260604/K8sGPT_vs_AWSops_Research.md` (22 sources; Findings 4–6 + Recommendations).
- ADR-029 (Mutating Action Framework — remediation gating), ADR-030 (ECS Fargate + Aurora; P2 worker backbone), ADR-031 (Runtime-Customizable Agents), ADR-032 (Event-Triggered Autonomous Incident Lifecycle), ADR-034 (Alert Auto-RCA Write-Back), ADR-016 (Bedrock Model Selection), ADR-033 (AIOps LLM Cost Optimization).
- Component reference: `docs/superpowers/reference/05-agentcore.md`, `06-workers.md`, `07-eks.md`.
- K8sGPT: GitHub `k8sgpt-ai/k8sgpt`, docs `docs.k8sgpt.ai`, CNCF project page; AWS — "Use K8sGPT and Amazon Bedrock…" and "Automate Amazon EKS troubleshooting using an Amazon Bedrock agentic workflow."
