# ADR-040: Governed External Knowledge/Comms Writes — scoped un-freeze of the 2026-06-11 reversal / 거버넌스된 외부 지식·커뮤니케이션 쓰기 — 2026-06-11 reversal의 좁은 해제

## Status / 상태

Accepted (2026-06-14) / 채택 (2026-06-14) — **owner-confirmed** after a co-agent decision panel (kiro-kimi/opus/glm · codex · gemini; Claude chair). Panel split: **3 conditional-"un-freeze-narrow" (codex, gemini, kiro-glm) · 1 strong dissent "keep frozen" (kiro-opus) · 1 no-verdict (kiro-kimi)**. The dissent's decisive objection (data-exfiltration channel + low marginal value vs ADR-012) is **not dismissed — it is converted into hard conditions** below. Panel record: `docs/reviews/2026-06-14-external-write-unfreeze-consensus.md`.

This is a **narrow, scoped partial un-freeze** of the 2026-06-11 reversal (`docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`) — it does **NOT** reverse that decision; AWS-resource mutation + autonomy stay **permanently reversed**. Implementation is **deferred (future phase, ships flag-OFF, owner enables)**; this ADR records the decision + the guardrails it must be built behind.

## Context / 컨텍스트

ADR-039 introduced the Integrations axis with a `READ_WRITE` capability (governed external writes via the ADR-029/036 mutating gate). The **2026-06-11 high-risk reversal** (3/3 unanimous + owner) then **froze the entire write/mutation/autonomy direction** — ADR-029/036 REVERSED (mutating substrate do-not-enable), ADR-031 Phase 3 (BYO-MCP) + Phase 4 (mutating tools) 폐기, ADR-032/035 downgraded to read-only — on the thesis: *"AWSops' core value = read-only ops dashboard + AI-diagnosis; mutation/autonomy/external-endpoint = scope-creep a small team cannot safely maintain, duplicates SSM/Change-Manager/IaC/console, permanent security surface (IAM blast radius, approval/rollback correctness, egress/SSRF/credential custody); analysis stays in AWSops, action stays with humans/existing tooling."* The same panel **KEPT ADR-034** (RCA observability-write-back) 3/3 as **"low blast radius."**

The owner re-opened a narrow question (2026-06-14): the reversal's heaviest fire targeted **AWS-resource mutation + autonomy**. **External knowledge/comms writes** (post a Slack message, create/update a Notion/Confluence page, file a Jira/ServiceNow ticket or comment) are arguably a **different risk class** — annotative/reversible, **no IAM mutation, no SSM/Change-Manager/IaC duplication** — and analogous to the KEPT ADR-034 "recording" write. Should this narrow slice be un-frozen?

ADR-039's egress **READ** observability path (inc2, LIVE 2026-06-14) is unaffected by this ADR — the panel confirmed it is the KEPT **ADR-011** observability-read flavor, not the reversed ADR-031-P3 BYO-MCP; its only backlog item is the documented DNS-rebinding TOCTOU (→ P3 IP-pinning).

## Options Considered / 고려한 대안

### Option 1: Keep frozen (the dissent — kiro-opus) / 동결 유지
Write stays dead; agents read-only/recommendation-only. **Rationale (recorded, not dismissed):** (a) the write path routes through the frozen ADR-029/036 gate, so un-freezing = reviving the exact substrate the panel froze OR standing up a second substrate = the rejected scope-creep; (b) **ADR-034 is not a clean precedent** — its kept write hits the operator's **own internal AWS OpsCenter** (no third-party egress/credential custody), whereas agent-driven SaaS writes add a **real data-exfiltration channel** (a prompt-injected agent posting inventory/topology/secrets to an external system) = a genuinely different risk class **worse on the axis that matters**; (c) the "tell humans" need is **already served by the live one-way templated ADR-012 Slack notification**, so marginal value is low against a permanent maintenance/exfiltration surface.

### Option 2: Un-freeze ONLY external knowledge/comms writes (CHOSEN) / 외부 지식·커뮤니케이션 쓰기만 해제 (채택)
Scoped carve-out for NON-AWS-resource writes under the full ADR-039 §7 controls; AWS-resource mutation + autonomy stay reversed.

### Option 3: Un-freeze the full write path / 전체 write 경로 해제
Rejected — re-opens AWS-resource mutation + the blanket 029/036, contradicting the 2026-06-11 thesis directly.

### Option 4: Draft-only / human copy-paste (no live API write) / 초안 전용
Kept as the **fallback** if any of Option 2's hard conditions (esp. exfiltration containment) cannot be met for a given connector: the agent renders a draft (ticket body / page / message) that a human copy-pastes — zero egress-write surface.

## Decision / 결정

Adopt **Option 2 — a narrow, scoped un-freeze for governed external knowledge/comms writes only**, behind ADR-039's `READ_WRITE` capability + the ADR-039 §7 mutating-gate controls, decoupled from the blanket-reversed AWS-resource substrate. **Implementation is deferred to a future phase, ships flag-OFF, owner enables.** It MUST be built behind these **hard conditions** (any not met for a connector ⇒ fall back to Option 4 draft-only for that connector):

1. **NON-AWS-resource ONLY.** Writes target external knowledge/work/comms SaaS (Notion/Confluence/Jira/ServiceNow/Slack) — **never** AWS resources. AWS-resource mutation + autonomy remain ADR-029/036/031-P4 reversed. No SSM/Change-Manager/IaC duplication.
2. **Exfiltration defense (the dissent's decisive point).** Every write payload passes **egress DLP/redaction**: **no secrets/credentials, no raw inventory/topology/account dumps** may leave in a write body; a **per-connector destination allowlist** (only the admin-registered SaaS target); content-size caps; the redaction is server-side + audited. (If a connector's writes cannot be reliably redacted → Option 4 draft-only.)
3. **Full ADR-039 §7 mutating-gate controls.** `action_catalog` facade (`executor_type='lambda'`), **`enabled=false` default**, mandatory **dry-run**, **4-eyes (approver≠creator)** or logged single-operator escape (ADR-029 §4), **paired rollback_ref**, **kill-switch (fail-closed)**, idempotency token (ADR-036 `job_id==SFN execution-name`), audit (Aurora + S3 Object-Lock). Model only *proposes inputs* — never writes directly.
4. **Decoupled narrow substrate.** Re-enable applies ONLY to the per-action **lambda executor** doing the external SaaS API call; it does **not** revive the AWS-resource SSM/Change-Manager automation. ADR-029/036 stay reversed for AWS-resource scope.
5. **No BYO-MCP / arbitrary HTTP.** Only curated, admin-registered, typed first-party connectors (vendor presets). Arbitrary writable BYO-MCP stays dead (ADR-031 P3 reversed).
6. **Value bar.** Justified value = agent **files a ticket / posts an incident note / updates a runbook page** — beyond ADR-012's one-way templated severity→channel Slack notification (which stays the owner of *system* notifications; this is *agent-proposed governed* writes, reusing the ADR-012 client/credential).
7. **Phased + flag-gated + owner-enabled.** Ships flag-OFF ($0/dark); a per-account flag; owner explicitly enables; revisitable/reversible.

AWSops를 **"분석은 AWSops, 행동은 사람"** 원칙 아래 유지하되, **외부 지식·커뮤니케이션 기록 쓰기**(AWS 리소스 변경 아님)만 위 7대 하드 조건 하에 좁게 해제한다. AWS 리소스 변경·자율 실행은 영구 reversed 유지.

## Consequences / 결과

### Positive / 긍정적
- Agents can **record/notify** in the team's existing systems (ticket, runbook, incident note) under audited human-gated governance — closing the loop the read-only dashboard can't.
- **Reuses the already-built ADR-039 §7 substrate** (action_catalog + dry-run + 4-eyes + rollback + kill-switch) — no new engine.
- The 2026-06-11 thesis is **preserved where it matters**: AWS-resource mutation + autonomy stay frozen; this is recording/comms, not infrastructure action.
- Reversible/flag-gated; Option-4 draft-only fallback bounds any connector that can't meet the exfiltration bar.

### Negative / 부정적 (리스크 — 반대 의견 기록)
- **Data-exfiltration channel (kiro-opus, decisive):** a prompt-injected agent could attempt to post internal data externally → mitigated by Condition 2 (DLP/redaction + destination allowlist + size caps + audit), but this is a **permanent, non-trivial surface** the read-only product did not have. **This is the primary risk; if Condition 2 proves insufficient in practice, fall back to Option 4 / re-freeze.**
- **Re-enabling §7 controls = re-enabling ADR-029/036 in scoped form** — a slippery slope; mitigated by Conditions 1+4 (non-AWS-resource only; decoupled executor; AWS-resource scope stays reversed) + the flag gate.
- **Small-team maintenance burden** (egress/credential custody/approval/rollback correctness) — accept consciously; flag-OFF until the team commits to maintaining it.
- **Marginal value vs ADR-012** for pure notification — accept that the *incremental* value is ticket/record creation, not notification (ADR-012 keeps notification).

### Relationship to other ADRs / 다른 ADR 관계
- **Extends ADR-039** (R2 READ_WRITE) — this is the governance gate ADR-039 §7 deferred to.
- **Partial scoped un-freeze of ADR-029/036 + ADR-031 Phase 4** — ONLY for the non-AWS-resource external-write lambda executor; AWS-resource mutation stays reversed (update those ADRs' reversal notes to cite this carve-out).
- **ADR-034 precedent** (low-blast-radius observability-write KEPT) — the analogy that motivated the carve-out (with the noted caveat that ADR-034 is internal-only, hence Condition 2).
- **ADR-012** Slack — split by ownership (system notify vs agent governed write), reuses ADR-012 client.
- **ADR-011 / §11** — egress SSRF/credential custody inherited.

## References / 참고 자료
- Decision panel: `docs/reviews/2026-06-14-external-write-unfreeze-consensus.md`.
- The reversal this scopes: `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`.
- Companion spec: `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md` (§7 WRITE path, §16).
- Extends **ADR-039**; scoped carve-out of **ADR-029/036/031-P4**; precedent **ADR-034**; consumes **ADR-011/012/023/033**.
