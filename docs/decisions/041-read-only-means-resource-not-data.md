# ADR-041: "Read-only" means RESOURCE read-only — external DATA integration (read + write) is permitted under governance / "read-only"는 리소스 read-only — 외부 데이터 통합(read+write)은 거버넌스 하 허용

## Status / 상태

Accepted (2026-06-14) / 채택 (2026-06-14) — **owner clarification + re-scope** of the 2026-06-11 high-risk reversal (`docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`). The 2026-06-11 panel ADVISED ("external-endpoint = scope-creep"); the **owner DECIDED then, and now CLARIFIES the intent**: the load-bearing line is **AWS-RESOURCE mutation + autonomy**, NOT external data integration. This is the **keystone ADR** that collapses the ADR-029/036/031/032/039/040 tangle into one coherent stance. (This re-scopes a multi-AI consensus by owner authority — recorded transparently; the panel's security concerns are **preserved as controls**, not discarded. A multi-AI review of this ADR is available on request but not required for an owner re-scope of an owner-confirmed decision.)

> **Governance addendum (2026-06-16, multi-AI panel — gemini-3.1-pro · kiro-opus-4.8 · kiro-kimi-k2.5 · kiro-glm-5):** the panel reviewed this very framing and returned **PARTIAL** (split labels; convergent rationale). Consensus reading: the *outcome* — external DATA read+write under governance — is **legitimate and properly ratified** by the **ADR-040 panel** (3 conditional / 1 strong dissent preserved as hard controls), so nothing security-bearing was decided unilaterally. **However**, the Status framing above is corrected for the record: the 2026-06-11 consensus **did** name "external-endpoint / egress / SSRF" as scope-creep in its decisive rationale, so this ADR is honestly an **owner-OVERRIDE that narrows that clause**, not a "clarification of original intent." The owner held final authority throughout (the panel was advisory) and the narrowing is within that authority — but it is recorded as an override, with binding authority for the external-write slice resting on the **panel-reviewed ADR-040**, not on this owner-solo ADR. The 2026-06-11 review record carries a matching dated addendum. / **거버넌스 addendum (2026-06-16, 멀티-AI 패널)**: 위 Status의 "원래 의도 명확화" 표현을 정정 — 2026-06-11 합의문은 external-endpoint/egress/SSRF를 명시 scope-creep으로 적시했으므로, 본 ADR은 그 조항을 **좁히는 owner-override**(clarification 아님)로 기록. 외부-write 결과 자체는 **ADR-040 패널 비준**으로 정당하며 외부-write의 구속 권위는 ADR-040에 둠. 리소스 변경·자율 동결 불변.

> **Coherence addendum (2026-06-17, multi-AI ADR-reconcile panel — Claude opus/sonnet/haiku lenses + gemini-3.1-pro cross-family; codex/kiro unavailable):** the panel (cross-family consensus: opus L1 + gemini independently) flagged that the resource-vs-data **binary** above does not cleanly classify **AWS-NATIVE observability-metadata writes** — specifically ADR-034's write-back to **SSM OpsCenter OpsItems / Incident Manager incidents** (`ssm:CreateOpsItem`, `ssm-incidents:*`). Such a write touches an AWS service, so it is neither "external DATA" (not Slack/Notion/Jira) nor the frozen "AWS-RESOURCE mutation" (infra / SSM **Automation** / Change Manager / IaC apply that changes operating-resource state). Clarification, **not** a new decision: there is a **third tier — AWS-native observability-metadata write** (create/annotate/resolve an OpsItem or incident *record*; no operating-resource state change; recommendation-only; low blast radius). This tier is **NOT** what the Decision §1 FROZEN clause forbids; it is governed like a DATA write via ADR-034's own control subset (scoped IAM `ssm:CreateOpsItem`/`ssm-incidents:*`, admin gate, audit, idempotency/dedup, body-render dry-run, resolve/annotate rollback), not frozen like an infra mutation. **However, ADR-034 ships frozen-in-practice by inheritance:** its current IAM path reuses the frozen ADR-029/036 substrate role (`action_opscenter_write`, `count = remediation_enabled` in `remediation.tf`), so enabling it today would require flipping the do-not-enable `remediation_enabled` flag. Therefore ADR-034 stays **flag-OFF / do-not-enable until it is decoupled onto a self-contained role behind its own `rca_writeback_enabled` gate** (fail-closed today) — even though its capability *tier* is permitted in principle. The §"Re-scope mapping" ADR-032/034 row is read with this tiering. / **정합성 addendum (2026-06-17, 멀티-AI ADR-정합 패널 — Claude opus/sonnet/haiku 렌즈 + gemini-3.1-pro cross-family; codex/kiro 불가)**: 위 리소스-vs-데이터 **이분법**이 **AWS-네이티브 관측 메타데이터 write**(ADR-034의 OpsCenter OpsItem/Incident Manager write, `ssm:CreateOpsItem`/`ssm-incidents:*`)를 깔끔히 분류하지 못함을 패널이 지적(opus L1 + gemini 교차합의). 이는 외부 DATA(Slack/Notion/Jira)도, 동결된 AWS-리소스 변경(인프라/SSM **Automation**/Change Manager/IaC)도 아님. 정정(신규 결정 아님): **제3티어 — AWS-네이티브 관측 메타데이터 write**(OpsItem/인시던트 *기록* 생성·주석·해제, 운영 리소스 상태변경 없음, 권고전용, 저 blast-radius)는 Decision §1(FROZEN) 동결 대상이 **아니며** ADR-034 자체 통제 부분집합(스코프 IAM·admin 게이트·감사·멱등·본문렌더 dry-run·해제 rollback)으로 데이터-write처럼 거버넌스. **단 ADR-034는 상속에 의해 실무상 동결 출하**: 현재 IAM 경로가 frozen 029/036 role(`action_opscenter_write`, `count = remediation_enabled`)을 재사용 → 지금 켜려면 do-not-enable인 `remediation_enabled`가 필요. 따라서 034는 **자족 role 분리 + 전용 `rca_writeback_enabled` 게이트로 decouple하기 전까지 flag-OFF·do-not-enable 유지**(현재 fail-closed) — 티어 자체는 원칙상 허용되더라도. 아래 §재정합 표의 032/034 행은 이 티어링으로 읽는다.

## Context / 컨텍스트

After ADR-039 (Integrations axis: external read + governed write) and the 2026-06-11 reversal (which froze "mutation/autonomy/**external-endpoint**" directions citing "egress/SSRF/credential custody"), the governance state became tangled: ADR-029/036 reversed, ADR-031 Phase 3/4 폐기, ADR-039 write path frozen-then-scoped-by-ADR-040 — while the product roadmap is to host **AWS DevOps / FinOps / Security Agent-style integrations** (which integrate with external knowledge/work/comms systems, read AND write). The 2026-06-11 text read broadly enough to forbid even external data integration, contradicting that roadmap.

The owner's clarifying principle resolves it: **"read-only" was always about AWS RESOURCES, not about DATA.** Reading external observability and writing external records/tickets/messages are DATA operations — they do not create/modify/delete AWS resources and they are not autonomous AWS actions. They are exactly what the AWS agent model does.

## Decision / 결정

**The "read-only" posture applies to AWS-RESOURCE STATE + AUTONOMY, not to external DATA.** Specifically:

1. **FROZEN (the real read-only constraint, unchanged):** create/modify/delete of **AWS resources** (SSM Automation, Change Manager, infra mutation, IaC apply) and **autonomous action** (acting on AWS resources without human approval). ADR-029/036 stay reversed *for AWS-resource scope*; ADR-032 autonomous mitigation stays frozen.

2. **PERMITTED under governance (DATA integration — first-class):**
   - **External DATA READ** — observability/knowledge (Grafana/Datadog/Prometheus/Loki, wikis). Already LIVE (ADR-039 inc2 / ADR-011).
   - **External DATA WRITE** — records/work/comms (Notion/Confluence page, Jira/ServiceNow ticket, Slack message). Governed by **ADR-040** controls. Writing a *record/message* to an external system is a DATA operation, **not** an AWS-resource mutation — so it is not what the read-only constraint forbids. This is the AWS DevOps/FinOps/Security agent integration model.

3. **The 2026-06-11 "external-endpoint" concern is re-interpreted as a CONTROLS mandate, not a prohibition.** Egress/SSRF/credential-custody/exfiltration risk is **real** and is discharged by mandatory controls — NOT by banning data integration:
   - Connection-time **SSRF** (https + DNS resolve-and-recheck + metadata/private block + redirect:manual) — inc2, LIVE.
   - **Credential custody** in Secrets Manager (ARN-ref, runtime fetch, per-account scoping) — inc2, LIVE.
   - **Curated/admin-registered connectors only** — no arbitrary writable BYO-MCP (ADR-031 P3's *uncurated* form stays out; curated typed data connectors are in).
   - For writes: **egress DLP/redaction + destination allowlist** (no secrets/topology/raw-inventory dumps leave), **action_catalog + dry-run + 4-eyes + paired rollback + kill-switch + audit**, **flag-OFF default** — ADR-040.

**원칙: 리소스 변경·자율 = 동결 / 외부 데이터 통합(read+write) = 거버넌스(SSRF·시크릿·DLP·큐레이션·human-gate·flag) 하 허용.**

## Re-scope mapping / 재정합

| ADR | Before (2026-06-11) | Under ADR-041 |
|---|---|---|
| 029 / 036 (mutating substrate) | REVERSED (all) | **AWS-resource mutation stays reversed**; the action_catalog/4-eyes/kill-switch facade may be reused for **external DATA writes** (ADR-040), decoupled from AWS-resource. |
| 031 Phase 3 (BYO-MCP) | 폐기 | **Curated external DATA-integration connectors (read/write) permitted** under controls; arbitrary/uncurated/writable BYO-MCP stays out. |
| 031 Phase 4 (mutating tools) | 폐기 | **External DATA-write tools permitted** (ADR-040 controls); **AWS-resource-mutating tools stay frozen**. |
| 032 (autonomous incident) | DOWNGRADED | Unchanged — read-only investigation/Triage/RCA + ADR-034 **AWS-native observability-metadata write-back** (OpsItem/Incident Manager *record* — the third tier, see 2026-06-17 coherence addendum; **flag-OFF until role-decoupled**); **autonomous AWS-resource mitigation stays frozen**. |
| 039 (Integrations axis) | write path frozen | **Data read+write fully in scope** under controls; 039 is the substrate, 040 the write controls. |
| 040 (external comms/knowledge writes) | "scoped exception/un-freeze" | Re-framed: not an *exception* but the **standard data-write governance** under ADR-041's principle. |

## Consequences / 결과

### Positive / 긍정적
- **One coherent stance** — collapses the tangle: *resource mutation/autonomy = frozen; data integration = governed-open*.
- Unblocks the **AWS-agent-parity integration feature** (DevOps/FinOps/Security agents integrate with external data systems, read+write).
- Clear mental model for future connectors: "Does it change an AWS resource or act autonomously? → frozen. Does it read/write external DATA? → allowed under the controls."

### Negative / 부정적 (리스크 — 정직)
- **Re-scopes a 3-AI unanimous, owner-confirmed reversal** by owner authority. Legitimate (owner decided then too; the panel advised), but it narrows the panel's broader "external-endpoint" stance → recorded here for honesty.
- **The egress/exfiltration surface is real** and does not vanish with the reclassification — it is contained by the controls (§3). If a connector cannot meet the exfiltration bar → ADR-040 Option-4 draft-only. If controls prove insufficient in practice → re-freeze.
- **Small-team maintenance** of the data-write controls — accept consciously; ships flag-OFF, owner enables.

## References / 참고 자료
- Re-scopes: `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`.
- Governs the write controls: **ADR-040**. Substrate: **ADR-039**. Resource-mutation freeze: **ADR-029/036/032**. SSRF/datasource: **ADR-011**. Reference model: AWS DevOps/Security/FinOps Agent (Capability Providers).
