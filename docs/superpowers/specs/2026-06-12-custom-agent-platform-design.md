# Design Spec: Custom Agent Platform — Frontier Agents + Integrations Axis (extends ADR-031)

- **Status**: Draft (2026-06-12) — companion to ADR-031; proposes ratification as **ADR-039**.
- **Supersedes**: `docs/superpowers/archive/2026-05-31-custom-agents-skills-design.md` (the original ADR-031 spec — its catalog/resolver/Agent-Space model is carried forward and extended here).
- **Owner**: AWSops AI layer.
- **Decision inputs**: AWS DevOps Agent + Security Agent customization model (the explicit reference); FinOps Foundation framework (forthcoming FinOps agent); multi-AI co-agent decision on the Integrations axis (Option 4, codex+gemini unanimous, kiro concurring on the single-substrate principle).

---

## 한국어 요약 (TL;DR)

AWSops를 **여러 프런티어 AI 에이전트(DevOps · Security · FinOps, 그리고 N개로 확장 가능)를 호스팅·커스터마이즈하는 플랫폼**으로 만든다. AWS DevOps Agent의 커스터마이징 모델(Agent Space + Skills + MCP + Capability Providers, dual-console UX)을 차용하되, 두 가지를 **확장**한다: (R1) 에이전트들이 **함께 오케스트레이션**되어 협업(ADR-032 Lead/Sub 재사용), (R2) **read/write 외부 통합**(Notion·Confluence 등) — AWS의 read-only 권고를 넘어, 쓰기는 기존 mutating gate(ADR-029/036)로 거버넌스.

**4개 기둥(축):**
1. **Frontier Agents** — DevOps/Security/FinOps를 1급 카탈로그 객체로(현재 `agents`를 확장: 멀티-게이트웨이 스코프 + agent-type + 응답언어 + 연결된 integrations). built-in 시드 + custom.
2. **Skills** — 재사용 지시 패키지(SKILL.md frontmatter + Markdown + references/assets). UI 폼 / zip 업로드. agent-type 타게팅. (`skills`/`agent_skills` 확장.)
3. **Integrations** (신규 축, **Option 4**) — 외부 커넥터를 1급 **타입드 카탈로그**로 노출하되 **실행 substrate는 단일 MCP 하나**. `READ` vs `READ_WRITE` 능력 플래그 → 쓰기는 자동으로 mutating gate(action_catalog → P2 워커)로. 공유 capability provider(모든 에이전트가 재사용).
4. **Agent Spaces** — 계정별 활성화·스코핑·도구 cap(기존 `agent_spaces` 확장: enabled integrations 추가).

**실행 substrate는 바꾸지 않는다** — 공유 AgentCore Runtime + Aurora 카탈로그 + registry-agnostic `agent.py` + resolver. 커스터마이즈는 **데이터**이지 재빌드가 아니다.

**핵심 보안 마감(현존 갭):** (a) `agent.py`가 `toolAllowlist`를 실제 강제하도록(현재 무시 — no-op), (b) revocation fail-closed, (c) write 통합은 mutating gate 경유만, (d) 마이그레이션 드리프트(카탈로그 테이블이 ULID 마이그레이션에 부재) 해소.

**권한 분리:** Agent Space·Integration/MCP 등록 = admin. Skill·Agent 작성·조합 = 일반 사용자(read-only 도구 범위). 위험 표면(egress/쓰기 자격증명)만 admin gate.

---

## 1. Goals / Non-goals

### Goals
- Host **multiple frontier agents** (DevOps, Security, FinOps) as first-class, **extensible to N** — adding FinOps is a seed row + capability wiring, not a code fork.
- Mirror the **AWS DevOps Agent customization model** (Agent Space, Skills, account-level capability registration, tool allowlisting, agent-type targeting, Active/Inactive) and its **dual-console UX**.
- Add a first-class **Integrations axis** (Capability Providers) — ONE catalog/UI spanning both directions: **egress** observability (Grafana/Datadog/Splunk/New Relic/Prometheus, READ) and read/write knowledge/work/comms systems (Notion/Confluence/Jira/ServiceNow/Slack, READ_WRITE, writes via the mutating gate), **and ingress** webhook alarm sources (CloudWatch SNS / Alertmanager / Grafana / PagerDuty / Datadog / generic) that trigger the incident lifecycle via the existing ADR-022 webhook + ADR-032 triage.
- **Federate** agents (R1): DevOps/Security/FinOps work in concert via the existing ADR-032 Lead/Sub orchestration over a shared Agent Space.
- **direct-compose first**, with **optional lightweight AI-assist** (draft a SKILL.md from a description; suggest a tool/integration allowlist).
- Customization is **data on a shared runtime** — no per-agent infra, no Docker rebuild (preserve ADR-031's core property).
- Close the **known runtime/security gaps** (tool-cap enforcement, fail-closed revocation, migration drift, admin reachability).

### Non-goals (YAGNI)
- A generative "agentcore creator" that provisions a dedicated AgentCore Runtime per agent (rejected: contradicts the no-rebuild substrate; the user de-scoped this — "스펙이 너무 넓다").
- Per-user agents; cross-org/cross-account agent federation beyond ADR-008; a public skill/integration marketplace.
- Learned Skills (auto-generated topology / tool-use best practices) — noted as a **later phase**, not in the first build.
- Replacing the section gateways or ADR-038 hybrid routing.
- A second execution/egress substrate for integrations (the co-agent decision explicitly forbids this).

---

## 2. Reference model (what we mirror) and our extension

AWS frontier agents (DevOps Agent, Security Agent; FinOps Agent forthcoming) are all **built on Amazon Bedrock AgentCore** and split customization into **three axes** inside a per-account **Agent Space** (a logical container defining what the agent can access):

| Axis | AWS concept | What it is |
|---|---|---|
| **Skills** | DevOps Agent Skills | Non-executable knowledge: `SKILL.md` (frontmatter `name`+`description`, Markdown instructions) + `references/` + `assets/`. UI form or ≤6 MB zip. Agent-type targeting. Active/Inactive. |
| **MCP Servers** | account-level MCP registration | Tools via Streamable HTTP; OAuth2 / API-key / **SigV4**; per-Agent-Space tool allowlist; read-only guidance. |
| **Capability Providers / Integrations** | GitHub, GitLab, Grafana, Datadog, Splunk, ServiceNow, PagerDuty, Slack | Typed first-party connectors with their own connection + auth lifecycle; feed **tools AND context** (topology, dashboards, deployment data). |

**Agent types** (fixed lifecycle roles, not user-created): Generic / On-demand / Incident Triage / Incident RCA / Incident Mitigation / Evaluation. Skills target one or more.

**Our two extensions beyond AWS:**
- **R1 — Federation**: AWS DevOps Agent is one agent with sub-types; we host *multiple* frontier agents that must be orchestrated together. We reuse our ADR-032 Lead/Sub incident lifecycle as the orchestration spine.
- **R2 — read/write Integrations**: AWS guidance is read-only. We need governed writes (Notion/Confluence create/update, ticketing, comms). Each integration carries a `READ` vs `READ_WRITE` capability; writes are bound to the ADR-029/036 mutating gate.

---

## 3. Current state (grounded) — what exists, what's missing

> Verified by reading the live code/ADRs (not assumed). Exact contracts in §6/§9.

**Substrate (reuse as-is):**
- Shared AgentCore Runtime; `agent.py` is **registry-agnostic** — it executes a resolved spec via payload `{messages, gateway, skill, systemPromptOverride, accountId, accountAlias}`. `SKILL_BASE` has 9 persona keys (`network, container, ops, data, security, monitoring, cost, diagnostics, iac`; `DEFAULT_GATEWAY='ops'`). Gateways discovered via `bedrock-agentcore-control list-gateways` or `GATEWAYS_JSON`.
- Chat routing (ADR-038): **explicit section pin > custom-agent keyword match > Haiku/regex classifier**, with an inactive-section guard.
- Resolver (`web/lib/agent-resolver.ts`): `resolveAgent()` builds `systemPromptOverride = SAFEGUARD_LINE + persona + ordered skill instructions` and an (advisory) `toolAllowlist`.
- Catalog (`web/lib/catalog.ts` + Aurora): `skills`, `agents` (single `gateway`), `agent_skills` (M:N + `ord`), `agent_spaces` (per-account), `customization_audit`. Custom rows default `enabled=false`; 8 built-in gateway agents seeded `enabled=true`.
- Mutating gate (ADR-029/036): governed write path **already exists** — `POST /api/actions` (plan, idempotency token, paired rollback, dry-run) → `POST /api/actions/[id]` (execute: flag + kill-switch + 4-eyes + not-expired gates) → `worker_jobs(type='action')` → SQS → dispatcher → remediation SM → per-action executor. `action_catalog` is the single facade (executor_type ∈ {ssm, lambda, fargate}). **All flag-off** today.
- Federation (ADR-032): Lead/Sub over a Step Functions Map; composition unit = **Agent Space**; `agent_bridge.invoke` mirrors `resolveAgent`. **Flag-off** today.
- Admin/auth: `isAdmin` = Cognito group OR SSM email allowlist (fail-closed); `verifyUser` = RS256 JWKS; `currentAccountId()='self'`.

**Confirmed gaps this spec must close:**
1. **Tool cap is a runtime no-op** — `agent.py` never reads `payload.toolAllowlist`; it loads ALL gateway tools. ADR-031's "enforce outside the model" is not actually enforced.
2. **`KNOWN_TOOL_CATALOG` is all-null** — the skill∩catalog intersection dimension is dead.
3. **Revocation not fail-closed** — 30 s cache TTL on the chat hot path; a disabled agent can still be selected for ≤30 s.
4. **No first-class frontier-agent object** — DevOps/Security/FinOps are personas/gateways, not selectable agents; `agents` is single-`gateway`.
5. **No Integrations axis, no BYO-MCP** — gateways are the fixed AgentCore set; no external connector registration; no read/write classification.
6. **No user-facing agent picker** — chat only pins built-in sections; custom agents reachable only via routingKeywords.
7. **UX gaps vs AWS** — no skill-create form, no agent-type, no zip/assets, no model picker, no AI-assist.
8. **Migration drift** — catalog tables live only in frozen `schema.sql` (integer ledger), not in ULID migrations; runner-only DBs may lack them.
9. **Admin unreachable in live** — zero Cognito admin-group members + blank SSM `admin_emails` → everyone 403 (ops fix, not code).
10. **Mutating gate not wired to chat** — chat mutation-safety is prompt directive + read-only IAM only.

---

## 4. Architecture — four pillars on the shared resolver substrate

```
                        ┌──────────────────────────────────────────────┐
                        │            AWSops Agent Platform              │
                        │                                              │
  ADMIN console ──────► │  Frontier Agents   Skills   Integrations     │ ◄── Operator / author
  (Agent Space,         │  (DevOps/Security/ (SKILL.md  (typed catalog  │     (compose, chat,
   Integration/MCP      │   FinOps + custom)  + assets)  over 1 MCP)    │      AI-assist)
   registration)        │         │             │            │         │
                        │         └──────┬──────┴─────┬──────┘         │
                        │            Agent Space (per account)          │
                        │         enabled agents/skills/integrations    │
                        │            + tool allowlist cap + version      │
                        └───────────────────┬──────────────────────────┘
                                             │  resolver (web/lib + python)
                                             ▼
            ┌──────────────────────────────────────────────────────────────┐
            │  Effective spec: persona + ordered skills + ENFORCED tool      │
            │  allowlist + integration context + agent-type                  │
            └───────────────┬──────────────────────────────┬───────────────┘
                            │ chat (resolveAgent)           │ federation (ADR-032 Lead/Sub)
                            ▼                                ▼
                  registry-agnostic agent.py  ◄── single shared AgentCore Runtime
                            │
          ┌─────────────────┼───────────────────────────────┐
          ▼                 ▼                                 ▼
   section gateways   MCP tools (READ)              WRITE actions (READ_WRITE)
   (~120 read tools)  (incl. Notion/Confluence read)  → action_catalog → P2 worker
                                                        (ADR-029/036 mutating gate)
```

**Invariants:**
- Customization is data; the runtime executes a resolved spec. No per-agent infra, no rebuild.
- One execution substrate. Integrations are typed catalog/UX/governance metadata over **MCP registrations** — never a second runtime (the co-agent guardrail).
- Reads flow through the allowlisted tool set; **every write transits the mutating gate** (`action_catalog` → P2). The model never writes directly.
- The server-side tool allowlist is enforced **outside the model** (in `agent.py`), not merely advised.

---

## 5. Pillar 1 — Frontier Agents (first-class entity, Approach A)

Promote `agents` from a single-`gateway` persona to a **frontier-agent entity** that DevOps/Security/FinOps and custom agents all share.

**Model (extends the existing `agents` row):**
- `kind` / `agent_type`: the AWS lifecycle role set — `generic | on_demand | triage | rca | mitigation | evaluation`. Default `generic`. (Skills target these; see §6.)
- **Capability scope spanning multiple gateways/tools**: replace the single `gateway` with a `gateways JSONB` (ordered list of section keys) **plus** a `tool_allowlist`/integration binding. The single `gateway` column is kept (back-compat) and treated as `gateways[0]` during migration.
- `response_language` (per AWS Agent Space; Korean supported) — feeds the agent directive.
- `tier` (`builtin | custom`) — unchanged. Built-in seeds: `devops`, `security`, `finops` (each composing the relevant section gateways + a curated skill/integration set).
- `enabled` — unchanged (custom default false).

**Mapping the frontier agents to existing capabilities (no new gateways required for P1):**
| Frontier agent | Composes (section gateways) | First integrations |
|---|---|---|
| **DevOps** | ops, monitoring, container, iac, network | Grafana/Datadog (READ), Slack/Jira (READ_WRITE) |
| **Security** | security (+ iam tools) | (later) security feeds |
| **FinOps** | cost (+ FinOps MCP) | Notion/Confluence (READ_WRITE for cost reports), CUR/FOCUS feeds |

> FinOps domain structure (FinOps Foundation: Inform/Optimize/Operate; 4 domains; FOCUS) informs the FinOps agent's **skills** (e.g. `rate-optimization`, `anomaly-management`, `unit-economics`), not new schema.

**Runtime impact:** a multi-gateway agent requires `agent.py` to either (a) be invoked per gateway and synthesized (the ADR-032 Lead/Sub pattern), or (b) gain a multi-gateway tool-union mode. **P1 keeps single-gateway execution** (frontier agents seed one primary gateway), and multi-gateway/federation is delivered via the ADR-032 spine in a later phase — avoiding a deep `agent.py` rewrite up front.

---

## 6. Pillar 2 — Skills (authoring parity with AWS)

Extend `skills` + authoring to match AWS DevOps Agent Skills:
- **Frontmatter** (`name` kebab ≤64, `description` ≥100 chars recommended) — already validated; add a parser for zip-uploaded `SKILL.md`.
- **Agent-type targeting**: `agent_types JSONB` (default `["generic"]`) — a skill is evaluated only for matching agent types (context economy).
- **references/ + assets/**: optional artifacts stored in **S3** (content-hash keyed), `reference_keys JSONB` on the skill (the field existed in the original ADR-031 spec; wire it). ≤6 MB zip, **no `scripts/`** (non-executable only).
- **Active/Inactive** — maps to existing `enabled`.
- **AI-assist (optional)**: a "draft from description" action calls the existing classifier/Bedrock to generate a `SKILL.md` body + suggest a tool allowlist; the human edits and saves. The generated content is **untrusted** and passes the same validation/allowlist enforcement.

`agent_skills` (M:N, `ord`) is unchanged; composition order drives instruction concatenation.

---

## 7. Pillar 3 — Integrations axis (Option 4: typed catalog over one MCP substrate)

**Decision (co-agent, Option 4):** Integrations are a **first-class typed catalog + UX + governance concept**, but **mechanically every integration is an MCP registration** — one auth/egress/allowlist/mutating-gate code path. No second runtime.

**Object model — `integrations` (new table):** ONE catalog + ONE admin UI for every external connector — both **egress** (the agent reaches out: observability READ, Slack/Notion/Confluence/Jira READ_WRITE) **and ingress** (an external system reaches in: webhook alarm sources that trigger the incident lifecycle). Operators register "connect Datadog", "connect Slack", and "receive PagerDuty alerts" on the same screen.
- `id`, `name`, `kind` — egress: `grafana | datadog | splunk | prometheus | newrelic | notion | confluence | jira | servicenow | slack | github | gitlab | custom_mcp`; **ingress (webhook source): `cloudwatch_sns | alertmanager | grafana_alert | pagerduty | datadog_monitor | generic_webhook`** — and `description`.
- **`direction`: `egress | ingress`** — the new load-bearing dimension. (A vendor like Datadog/Grafana can appear as TWO rows: an `egress` READ connector AND an `ingress` alarm source — distinct connection/auth/lifecycle.)
- `connection` (**egress**): endpoint URL; `transport` (`sigv4 | oauth_client_credentials | oauth_3lo | api_key`); `credentials_ref` (Secrets Manager ARN — never plaintext); optional `private_connection_ref` (VPC path).
- `capability` (egress): **`READ | READ_WRITE`** — the load-bearing governance attribute for egress writes.
- **`ingress` fields**: `receive_path`/generated receive URL; `inbound_auth_ref` (the ADR-022 HMAC-SHA256 shared-secret in Secrets Manager); `source_allowlist` (sender IP/identity); `trigger_target` (`incident` → ADR-032 triage). Ingress carries NO outbound `credentials_ref`/`exposed_tools`.
- `exposed_tools JSONB` (egress, allowlistable tool ids), `provided_context JSONB` (typed context schema: topology/dashboards/wiki — injected into the effective spec).
- `write_action_refs JSONB`: for `READ_WRITE`, the `action_catalog` entries each write maps to (e.g. `notion.create_page` → catalog row `executor_type='lambda'`).
- `tier` (`builtin | custom`), `enabled` (default false), `created_by`, audit fields.

> P1 created the `integrations` table with the egress columns + free-text `kind` (unused at runtime). The `direction` column + the ingress columns above are an **additive P2 migration** (the P1 migration is committed/idempotent — not edited); a `kind` CHECK is added in P2 once the set stabilizes.

**Auth (SigV4 first, then OAuth/API-key):** mirror AWS exactly — SigV4 reuses IAM trust (confused-deputy `aws:SourceAccount`/`aws:SourceArn` conditions); OAuth Client Credentials / 3LO / API-key store secrets in Secrets Manager with rotation. Private VPC connections for self-hosted tools (analogous to AWS's VPC Lattice resource gateway; for us, our MCP Lambdas already run in-VPC).

**READ path:** allowlisted integration tools are added to the agent's effective tool set exactly like section-gateway tools, and enforced in `agent.py` (§9).

**WRITE path (R2 — the critical governance binding):** a `READ_WRITE` integration **does not expose raw write tools to the model**. Each write is an `action_catalog` row (`executor_type='lambda'`, `dry_run_contract`, paired `rollback_ref`, `approval_mode`, `enabled=false`). The model only *proposes inputs*; execution requires:
`POST /api/actions {action, inputs}` (admin, plan) → `POST /api/actions/[id] {op:'execute'}` (different admin: flag + kill-switch + 4-eyes + not-expired) → `worker_jobs(type='action')` → dispatcher → remediation SM → the per-action `lambda` executor performs the Notion/Confluence API call in-VPC, re-validating the catalog gate.

> Example: `notion.create_page` ships as a disabled catalog row with a paired rollback `notion.archive_page`; first dry-run renders the page body with no side effect.

**INGRESS path (webhook alarm sources — same UI, opposite direction):** an `ingress` integration is the **registration/config surface** for an external alarm source; it does NOT introduce a new ingestion engine (one-substrate principle). Registering one provisions a `receive_path` + an HMAC secret and **reuses the existing ADR-022 webhook route + ADR-032 incident triage**: external alarm → `POST` to the receive URL → ADR-022 HMAC verify + source allowlist → ADR-032 triage (New/Linked/Skipped) → Lead/Sub investigation. Governance differs from egress: ingress verifies **inbound** auth (HMAC, not stored outbound creds), rate-limits, and applies the ADR-034 self-marker **feedback-loop breaker** (drop events we ourselves emitted). The Integrations UI surfaces ingress rows with an "alarm source" badge + the copyable receive URL + secret rotation; the actual trigger/lifecycle stays in ADR-032 (R1 / P4).

**Shared across agents (R1):** integrations are **capability providers reused across DevOps/Security/FinOps** via the Agent Space (`enabled_integration_ids`), not bound to one agent.

---

## 8. Pillar 4 — Agent Spaces + Federation (R1)

**Agent Spaces (extend `agent_spaces`):** add `enabled_integration_ids JSONB` and `response_language`. Semantics unchanged: missing row ⇒ Phase-1 global behavior; tool allowlist cap can only REMOVE. The composition unit for both chat and federation.

**Federation (reuse ADR-032 Lead/Sub):** DevOps + Security + FinOps "work together" = a **Lead (Incident Commander) composes them as read-only Sub-agents** rostered from the Agent Space and fanned out over the Step Functions Map; RootCause synthesizes. This is **orchestration, not peer-to-peer** — and it already exists (flag-off). Two enhancements:
- **Per-account Agent Space scoping of the roster**: today `lead.py` reads all enabled agents globally; make it call `getAgentSpace(account)` and scope to `enabled_agent_ids` (matches the chat path).
- **Frontier-agent rostering**: the Lead rosters by frontier agent (devops/security/finops) + their gateways, not only raw section gateways.
- Mutation in any stage stays recommendation-only → ADR-029/036 gate. The Lead remains least-privilege (delegate-only).

> Federation rides the existing P2 backbone (`worker_jobs type='incident_stage'` → incident SM). No second spine.

---

## 9. Resolver & runtime changes (close the gaps)

1. **Enforce `toolAllowlist` in `agent.py` (gap #1, security-critical):** read `payload['toolAllowlist']`; when present and non-empty, filter `get_all_tools(mcp_client)` by tool name **before** `Agent(tools=...)` and before building the "## Available Tools" section. Empty/absent ⇒ current behavior (all tools). This makes ADR-031's "enforce outside the model" real.
2. **Fill `KNOWN_TOOL_CATALOG` (gap #2):** populate per-gateway tool inventories we can enumerate (mirror the gateway Lambda tool sets) so the skill∩catalog dimension actually narrows; keep `null` = degrade-safe for unknown gateways. Tightening only ever ADDS restriction.
3. **Fail-closed revocation (gap #3):** on disable/revoke, bust the `catalog-source` cache immediately for that account (version bump already busts; add an explicit invalidation on the disable path) so a disabled agent/skill/integration is unusable at once — not after 30 s. The 30 s window stays only for *enable* (non-security) changes.
4. **Integration context injection:** the resolver adds typed `provided_context` from enabled integrations into the effective spec (bounded size; counts toward token budget).
5. **agent-type & multi-gateway:** the resolver passes `agent_type`; multi-gateway union is deferred to the federation phase (P1 = single primary gateway).
6. **DRY the resolver:** `web/lib/agent-resolver.ts` (chat) and `scripts/v2/incident/agent_bridge.py` (federation) must stay byte-identical on `SAFEGUARD_LINE` and resolution semantics; add a cross-language parity test.

---

## 10. UX — dual-console, AWS DevOps Agent-style

**Admin console** (gated by `isAdmin`):
- **Agent Spaces**: create/scope per account; name, description, response language, enabled agents/skills/integrations, tool allowlist cap.
- **Integrations / Capability Providers** — ONE screen for both directions, filterable by a **direction** toggle (egress / ingress):
  - **egress** (kind picker → connection → auth wizard SigV4 / OAuth / API-key → review): per-vendor presets (Notion/Confluence/Grafana/Datadog/Slack), tool allowlisting per Agent Space, READ vs READ_WRITE, health check. Credentials → Secrets Manager.
  - **ingress** (webhook alarm source: cloudwatch_sns / alertmanager / grafana_alert / pagerduty / datadog_monitor / generic_webhook): the wizard **generates a receive URL + HMAC secret** (ADR-022), captures a source allowlist, and wires the source to the ADR-032 incident trigger. Listed with an "alarm source" badge; secret-rotation + copy-URL actions.
- **MCP servers** (custom_mcp kind): generic BYO-MCP registration (an egress integration).

**Operator / author** (general users, read-only scope; write registration stays admin):
- **Agents**: list built-in (devops/security/finops) + custom; compose (attach skills, set agent-type, pick gateways/integrations, model, routing keywords); enable/disable; **AI-assist** draft.
- **Skills**: create-in-UI form (name/description/instructions/agent-type) **and** ≤6 MB zip upload (references/assets); Active/Inactive; AI-assist draft.
- **User-facing agent picker (gap #6):** the chat UI gains an explicit agent selector (built-in + enabled custom) alongside the section pin, so custom agents are discoverable — not only reachable via routingKeywords.

**Permission split (confirmed):** Agent Space + Integration/MCP registration (egress + credentials) = **admin**; Skill + Agent authoring/composition within read-only tool scope = **any authenticated user**. Enabling a `READ_WRITE` integration or wiring a write action = **admin + the mutating-gate 4-eyes**.

---

## 11. Security & governance

- **Server-side allowlist outside the model** (§9.1) — the model cannot exceed the resolved tool set even if a skill/MCP description tries to widen it.
- **Untrusted content**: custom Markdown, MCP tool descriptions, and tool results are untrusted → immutable non-overridable `SAFEGUARD_LINE` (kept), server-side allowlist enforcement, output validation, prompt-injection posture (mirrors AWS guidance).
- **Writes → mutating gate only** (ADR-029 six controls + ADR-036): Action Catalog facade, two-step plan→execute with idempotency token, mandatory dry-run, 4-eyes (approver≠creator), paired rollback, audit (Aurora + S3 Object-Lock), kill-switch (fail-closed), flag-gated.
- **Credential custody**: Secrets Manager with rotation; SigV4 confused-deputy conditions; egress allowlist + per-account isolation for BYO-MCP/integrations; no plaintext in Aurora/env.
- **Fail-closed revocation** (§9.3) for security-relevant disables.
- **Integrity & traceability**: SHA-256 content hash on skills (exists); every response/log records Agent Space version + agent id/version + skill hashes (the BFF already sends these — also persist on the runtime side or in chat_messages.meta).
- **Cost (ADR-033)**: per-Agent-Space prompt-size/tool-count limits + token budget; integration context injection counts toward budget.

---

## 12. Phased delivery

> The full platform is large; deliver in bounded, independently-shippable, flag-safe phases. **Phase 1 is the first consensus-implemented slice** (code-only, no new infra apply required; closes real security gaps).

- **P1 — Foundation + gap-closure (consensus target):**
  1. ULID migration re-asserting the ADR-031 catalog tables **idempotently** (resolves drift) + additive columns: `agents.agent_type`, `agents.gateways JSONB`, `agents.response_language`; `skills.agent_types`, `skills.reference_keys`; `agent_spaces.enabled_integration_ids`, `agent_spaces.response_language`; new `integrations` table (created, flag-gated, unused at runtime in P1).
  2. **Enforce `toolAllowlist` in `agent.py`** + tests (gap #1).
  3. **Fill `KNOWN_TOOL_CATALOG`** for enumerable gateways (gap #2).
  4. **Fail-closed revocation** on disable (gap #3).
  5. Seed `devops`/`security`/`finops` built-in frontier agents (single primary gateway each) + `agent_type`.
  6. Catalog/lib + `/api/customization` + validation extended for the new fields; **skill-create form** + **model picker** + **agent-type** in the UI; **user-facing agent picker** in chat.
- **P2 — Integrations axis (READ + ingress):** additive migration adding `direction` + ingress columns (+ `kind` CHECK). The unified Integrations UI (egress/ingress toggle). Egress READ: `integrations` registration UX (SigV4-first) + per-space tool allowlisting + read context injection; first observability integrations (Grafana/Datadog) as read MCP. Ingress: webhook alarm-source registration (generate receive URL + HMAC secret + source allowlist) wired to the existing ADR-022 route + ADR-032 trigger.
- **P3 — Integrations axis (READ_WRITE) + AI-assist:** Notion/Confluence write actions as `action_catalog` `lambda` executors behind the mutating gate (dry-run + paired rollback); OAuth/API-key auth; AI-assist skill drafting.
- **P4 — Federation:** per-account Agent Space scoping of the ADR-032 Lead roster + frontier-agent rostering; enable DevOps+Security+FinOps to collaborate on an incident.
- **P5 — Learned Skills (optional):** topology/tool-use auto-skills from inventory + investigation history.

**Ops (not code, prerequisite for live):** create the `admins` Cognito group / populate SSM `admin_emails` so `/customization` is reachable (gap #9).

---

## 13. Acceptance criteria (P1)

- A ULID migration creates/asserts all ADR-031 catalog tables + new columns idempotently on a runner-only DB; re-running is a no-op; existing rows preserved (`gateway` → `gateways[0]`).
- `agent.py` invoked with a non-empty `toolAllowlist` exposes **only** those tools to the model and lists only them in the prompt; with empty/absent allowlist, behavior is unchanged. Unit + integration tested.
- Disabling a custom agent/skill makes it unusable on the chat path **immediately** (no 30 s window) — tested.
- `devops`/`security`/`finops` appear as selectable built-in agents in the UI and chat picker; selecting one routes to its primary gateway with its persona.
- Skill create-in-UI form persists a valid `SKILL.md`-equivalent row with `agent_types`; admin gate + audit unchanged.
- All new code TDD'd; `tests/run-all.sh` green; no AWS security-mandate violation (no `0.0.0.0/0`, no `Principal:"*"`, no secrets in env); no `-auto-approve` on shared infra.

---

## 14. Open questions / risks

- **9th gateway**: `external-obs` is not seeded in the catalog (only 8). Decide whether observability is a section gateway, folded into the Integrations axis (likely, per §7), or both. (Leaning: external observability = Integrations, internal CloudWatch = monitoring gateway.)
- **Multi-gateway execution**: P1 keeps single-primary-gateway; confirm federation (P4) is the right vehicle for multi-domain synthesis rather than an `agent.py` tool-union mode.
- **Migration ledger**: integer `schema_migrations` (baseline) vs ULID ledger coexistence — the P1 migration must be idempotent and not conflict with the one-time bootstrap.
- **AI-assist trust**: generated SKILL.md/allowlist is untrusted; enforced by the same allowlist/validation — confirm no path lets generated content widen scope.
- **Token/cost**: integration context injection size caps (ADR-033) must be set before P2.

---

## 15. ADR linkage

This spec extends **ADR-031** (runtime-customizable agents/skills) and consumes **ADR-029/036** (mutating gate), **ADR-032** (Lead/Sub federation), **ADR-038** (hybrid routing), **ADR-033** (cost), **ADR-008** (multi-account), **ADR-011** (SSRF allowlist), **ADR-023** (admin model). Given the new Integrations axis + frontier-agent entity + read/write governance, ratify as **ADR-039: Multi-Agent Platform — Frontier Agents + Integrations Axis** (extends ADR-031; mechanism via 036; federation via 032).
