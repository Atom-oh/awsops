# ADR-041: "Read-only" means RESOURCE read-only — external DATA integration (read + write) is permitted under governance / "read-only"는 리소스 read-only — 외부 데이터 통합(read+write)은 거버넌스 하 허용

## Status / 상태

Accepted (2026-06-14) / 채택 (2026-06-14) — **owner clarification + re-scope** of the 2026-06-11 high-risk reversal (`docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`). The 2026-06-11 panel ADVISED ("external-endpoint = scope-creep"); the **owner DECIDED then, and now CLARIFIES the intent**: the load-bearing line is **AWS-RESOURCE mutation + autonomy**, NOT external data integration. This is the **keystone ADR** that collapses the ADR-029/036/031/032/039/040 tangle into one coherent stance. (This re-scopes a multi-AI consensus by owner authority — recorded transparently; the panel's security concerns are **preserved as controls**, not discarded. A multi-AI review of this ADR is available on request but not required for an owner re-scope of an owner-confirmed decision.)

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
| 032 (autonomous incident) | DOWNGRADED | Unchanged — read-only investigation/Triage/RCA + ADR-034 data write-back OK; **autonomous AWS-resource mitigation stays frozen**. |
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
