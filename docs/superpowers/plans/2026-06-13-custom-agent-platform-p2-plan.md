# Implementation Plan — Custom Agent Platform P2 (Integrations axis: management + resolution layer)

> Spec: `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md` (Pillar 3 §7, ADR-039).
> Strategy: TDD (test-first) + Tidy First. Each task = one local commit. **Code + migration + tests only — NO Terraform/infra apply, NO live deploy.** Every new surface is admin-gated and flag-safe; registered integrations default `enabled=false` and have ZERO runtime effect until enabled in an Agent Space.
> Builds on P1: the `integrations` table exists (egress columns + free-text `kind`); `agent_spaces.enabled_integration_ids` column exists; `agent.py` already enforces `toolAllowlist`; `intersectToolAllowlist`/resolver are live.
> Test substrate: web unit = `cd web && npx vitest run lib/<f>.test.ts`; migration idempotency = PG17 container via `sudo docker` (skip-if-no-docker).

## Scope boundary (what P2 delivers vs what is DEFERRED to "P2-infra")

**IN (this plan — code/migration/tests):** the Integrations **management + resolution data layer** — additive migration (direction + ingress columns + `kind` CHECK), `integrations` CRUD lib + validation + SSRF host-guard (ADR-011) + admin `/api/integrations`, resolver wiring (enabled READ integrations' `exposed_tools` → effective allowlist; `provided_context` → prompt, size-capped), and the admin Integrations UI section (egress/ingress toggle + registration form).

**DEFERRED to P2-infra (controller-run, needs `terraform apply` / IAM / edge) — explicitly OUT of this plan:** Secrets Manager credential write/read + IAM; live `agent.py` connection to a registered external integration MCP endpoint (SigV4 + endpoint passing); the Lambda@Edge ingress carve-out for public SaaS webhooks; the dedicated first-class Integrations page + Settings-hub nav restructure (Q1); the concrete Grafana/Datadog/Notion connectors + ingress wiring to the ADR-032 trigger. **Until P2-infra lands, a registered integration's tool NAMES may enter the allowlist but `agent.py` only resolves tools it can actually reach (gateways), so there is no live external call — safe.**

## Files in scope

- `terraform/v2/foundation/migrations/01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql` — additive ingress/direction columns + `kind` CHECK + index
- `scripts/v2/migrations-p2.itest.mjs` — PG17-container idempotency harness
- `web/lib/integrations.ts` + `web/lib/integrations.test.ts` — catalog CRUD + `getEnabledIntegrations`
- `web/lib/integration-validation.ts` + `web/lib/integration-validation.test.ts` — pure validators
- `web/lib/ssrf-guard.ts` + `web/lib/ssrf-guard.test.ts` — ADR-011 private-host blocklist (pure)
- `web/app/api/integrations/route.ts` + `web/app/api/integrations/route.test.ts` — admin CRUD API
- `web/lib/agent-space.ts` + `web/lib/agent-space.test.ts` — `enabledIntegrationIds`
- `web/lib/agent-resolver.ts` + `web/lib/agent-resolver.test.ts` — integration tools + context injection
- `web/app/customization/page.tsx` — Integrations admin section (egress/ingress toggle + form)

## Tasks

### Task 1: Migration — integrations `direction` + ingress columns + `kind` CHECK (TDD via PG17)

**Files:**
- Create: `terraform/v2/foundation/migrations/01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql`
- Create: `scripts/v2/migrations-p2.itest.mjs`

- [ ] Failing itest (mirror `scripts/v2/migrations-p1.itest.mjs`): PG17 container; load `schema.sql` then the P1 migration then the P2 migration **twice**; assert new columns exist on `integrations` (`direction`, `auth_mode`, `receive_path`, `inbound_auth_ref`, `source_allowlist`, `trigger_target`); the `kind` CHECK + `direction` CHECK exist; idempotent re-apply (no error, identical row count); existing P1 `integrations` columns intact.
- [ ] Migration SQL (`-- since: 2.3.0`): `ALTER TABLE integrations ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'egress'`, `auth_mode TEXT`, `receive_path TEXT`, `inbound_auth_ref TEXT`, `source_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb`, `trigger_target TEXT`. Add pg_constraint-guarded CHECKs (DO block checking `pg_constraint.conname`, like P1): `integrations_direction_check` = `direction IN ('egress','ingress')`; and a **direction-CONDITIONAL `kind` CHECK** (gemini — a flat union would allow an egress row with an ingress kind): `integrations_kind_check` = `((direction='egress' AND kind IN ('grafana','datadog','splunk','prometheus','newrelic','notion','confluence','jira','servicenow','slack','github','gitlab','custom_mcp')) OR (direction='ingress' AND kind IN ('cloudwatch_sns','alertmanager','grafana_alert','pagerduty','datadog_monitor','generic_webhook')))`. `CREATE INDEX IF NOT EXISTS idx_integrations_dir_enabled ON integrations (direction, enabled) WHERE enabled = true`. No `schema_migrations` write. **Add the P1-style comment `-- SOURCE OF TRUTH: these kind/direction value sets are shared with web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS/INGRESS — keep in sync`.** NOTE: the P1 `integrations` table has **no `version` column** (unlike skills/agents) — do not add one and do not reference it in upserts.
- [ ] `node scripts/v2/migrations-p2.itest.mjs` green; `DRY_RUN=1 OFFLINE=1 make migrate` lists it. Commit `feat(agent-platform): P2 migration — integrations direction + ingress columns + kind CHECK`.

### Task 2: `integrations.ts` — catalog CRUD + getEnabledIntegrations (TDD)

**Files:**
- Create: `web/lib/integrations.ts`
- Test: `web/lib/integrations.test.ts`

- [ ] Failing vitest (getPool-mock pattern, mirror `catalog.test.ts`): `upsertIntegration` INSERT…ON CONFLICT(name) DO UPDATE **WHERE integrations.tier='custom'** (builtin-collision guard → `if rows.length===0 throw 'name conflicts with a built-in integration'`, like `upsertAgent`; assert the test exercises both the success and no-row throw paths); the upsert **does NOT reference `version`** (the integrations table has no version column); `listIntegrations` maps rows incl. direction/capability/kind/enabled + ingress fields; `setIntegrationEnabled(id,enabled)` custom-only; `getEnabledIntegrations(accountId)` returns enabled rows (used by the resolver). Disabled-by-default on insert.
- [ ] Implement `integrations.ts`: `IntegrationInput`/`IntegrationRow` types covering ALL columns including ingress — `{id,name,kind,direction,description,endpoint,transport,credentialsRef,capability,exposedTools,providedContext,writeActionRefs,authMode,receivePath,inboundAuthRef,sourceAllowlist,triggerTarget,enabled,tier}`; the SQL above (no version); audit via `import { writeAudit } from '@/lib/catalog'` (objectType:'integration').
- [ ] `cd web && npx vitest run lib/integrations.test.ts` green. Commit `feat(agent-platform): integrations catalog CRUD + getEnabledIntegrations`.

### Task 3: `integration-validation.ts` — pure validators (TDD)

**Files:**
- Create: `web/lib/integration-validation.ts`
- Test: `web/lib/integration-validation.test.ts`

- [ ] Failing tests: `INTEGRATION_KINDS_EGRESS`/`INTEGRATION_KINDS_INGRESS` + `INTEGRATION_TRANSPORTS=['sigv4','oauth_client_credentials','oauth_3lo','api_key']` (the P1 migration's transport CHECK set — source of truth shared with the migration; comment); `validateIntegration` enforces **kind ∈ the set matching `direction`** (egress kind on an ingress row → reject, matching the migration's conditional CHECK), rejects bad name (kebab), `capability`∉{read,read_write}, egress missing `endpoint`/invalid-URL/`transport`∉set, ingress missing `auth_mode`, and a provided `credentialsRef` that is empty or not `^arn:aws:secretsmanager:` / non-empty-string; `triggerTarget` (ingress) ∈ {incident}; accepts well-formed egress + ingress rows.
- [ ] Implement validators (pure, no I/O).
- [ ] `cd web && npx vitest run lib/integration-validation.test.ts` green. Commit `feat(agent-platform): integration validation (kind/direction/capability/transport)`.

### Task 4: `ssrf-guard.ts` — ADR-011 private-host blocklist (TDD)

**Files:**
- Create: `web/lib/ssrf-guard.ts`
- Test: `web/lib/ssrf-guard.test.ts`

- [ ] Failing tests: **implement the ADR-011 blocklist from the ADR spec — there is NO v1 code to mirror** (verified: `src/lib/datasource-client.ts` does not contain it). `isBlockedHost(hostOrIp)` returns true for literal private/link-local IPs — IPv4 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (incl. `169.254.169.254` metadata), `127.0.0.0/8`; IPv6 `::1`, `fc00::/7`, `fe80::/10`; returns false for public IPs / public hostnames. `assertEgressEndpointAllowed(urlString, {allowPrivate})` throws on a blocked literal-IP host unless `allowPrivate` (the per-account `allowPrivateDatasource` opt-in), and on non-https.
- [ ] Implement (pure CIDR/IP classification; document that DNS-resolution-before-request + `redirect:'manual'` are enforced at connection time in P2-infra — this module is the static endpoint-registration guard).
- [ ] `cd web && npx vitest run lib/ssrf-guard.test.ts` green. Commit `feat(agent-platform): ADR-011 SSRF host blocklist for egress integration registration`.

### Task 5: `/api/integrations` — admin CRUD API (TDD)

**Files:**
- Create: `web/app/api/integrations/route.ts`
- Test: `web/app/api/integrations/route.test.ts`

- [ ] Failing tests (mirror `app/api/chat/route.test.ts` / `customization/route.ts` mock style): `gate()` = verifyUser→401, isAdmin→403, AURORA_ENDPOINT→400 (registration is **admin-only**, ADR-023/§10). POST (egress|ingress) → `validateIntegration` (400 on fail) → for egress, `assertEgressEndpointAllowed` (409/400 on blocked private host unless allowPrivate) → `upsertIntegration` (409 on builtin-collision) → audit → 200{id}. GET → `listIntegrations`. PUT enable/disable (custom-only) + audit. credentialsRef accepted as an opaque ref string (Secrets Manager write is P2-infra).
- [ ] Implement the route.
- [ ] `cd web && npx vitest run lib/...`/`app/api/integrations/route.test.ts` green. Commit `feat(agent-platform): admin /api/integrations CRUD (SSRF-guarded registration)`.

### Task 6: resolver wiring — enabled integrations' tools + context (TDD)

**Files:**
- Modify: `web/lib/agent-space.ts`
- Test: `web/lib/agent-space.test.ts`
- Modify: `web/lib/agent-resolver.ts`
- Test: `web/lib/agent-resolver.test.ts`

- [ ] Failing tests: `AgentSpace` gains `enabledIntegrationIds: number[]` (default []; `getAgentSpace` selects `enabled_integration_ids`, nullish→[]); `resolveAgent(...)` accepts an optional enabled-READ-integrations arg and, for the custom path, **unions their `exposed_tools` into the declared tool set BEFORE the cap** — i.e. `declaredTools = [...orderedSkillTools, ...integrationExposedTools]; toolAllowlist = intersectToolAllowlist(gateway, declaredTools, space)` (NOT after — intersection would drop them) — and **appends bounded `provided_context` text** to `systemPromptOverride`, capped at **`MAX_PROVIDED_CONTEXT_CHARS = 2000`** (truncate-with-ellipsis; ADR-033 size bound). READ_WRITE integrations contribute **NO raw tools** (writes go via the gate). `SAFEGUARD_LINE` stays first. Built-in path byte-identical/unchanged.
- [ ] Implement: extend `AgentSpace` + `getAgentSpace`/`upsertAgentSpace` for `enabled_integration_ids`; thread enabled READ integrations into `resolveAgent` (union exposed_tools before `intersectToolAllowlist`; provided_context capped at 2000 chars). Keep `SAFEGUARD_LINE` first; assert the built-in branch is unchanged.
- [ ] `cd web && npx vitest run lib/agent-space.test.ts lib/agent-resolver.test.ts` green. Commit `feat(agent-platform): resolver injects enabled-integration tools + capped context`.

### Task 7: Integrations admin UI section

**Files:**
- Modify: `web/app/customization/page.tsx`

- [ ] Add an **Integrations** section to the admin customization page: an **egress/ingress toggle**; egress form (name/kind/endpoint/transport/capability) + **ingress form (name/kind/auth_mode/source_allowlist/trigger_target — and a read-only display of the generated `receive_path` after create)**; list with direction badge + enable/disable; POSTs `/api/integrations`. (The dedicated first-class Integrations page + Settings-hub IA per Q1 is a P2-infra/UI-polish follow-up; this section delivers the function admin-gated now.)
- [ ] Verify: `cd web && npx tsc --noEmit` (my files clean) + `npx next build` compiles. Commit `feat(agent-platform): customization UI — Integrations registration section`.

## Test gate (per commit; full at end)
- Task 1: `node scripts/v2/migrations-p2.itest.mjs`. Tasks 2–6: `cd web && npx vitest run lib/integrations.test.ts lib/integration-validation.test.ts lib/ssrf-guard.test.ts lib/agent-space.test.ts lib/agent-resolver.test.ts app/api/integrations/route.test.ts`. Task 7: `cd web && npx tsc --noEmit && npx next build`. Regression: full `cd web && npx vitest run` stays green (559+).

## Acceptance criteria
- P2 migration idempotent (twice → identical), adds direction/ingress columns + CHECKs on a runner-only DB (Task 1 itest green).
- `integrations` CRUD: register egress/ingress, builtin-collision guard, disabled-by-default, audited (Task 2).
- SSRF guard blocks literal private/metadata-IP egress endpoints unless `allowPrivate` (Task 4); `/api/integrations` is admin-only and SSRF-guards registration (Task 5).
- Enabling a READ integration in an Agent Space surfaces its allowlisted tool names + capped context to the resolver; READ_WRITE adds no raw tools (Task 6).
- Admin UI can register/enable/disable integrations (Task 7).
- No AWS security-mandate violation; no infra apply; no live external call (deferred to P2-infra); full web suite green; no change outside files-in-scope.

## Out of scope (P2-infra / P3)
Secrets Manager credential write/read + IAM; live `agent.py` external-MCP connection (SigV4 endpoint passing); Lambda@Edge SaaS-ingress carve-out; dedicated first-class Integrations page + Settings-hub nav; concrete Grafana/Datadog/Notion connectors; ingress→ADR-032 live wiring; READ_WRITE write-action executors (P3); AI-assist (P3).
