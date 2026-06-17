# AI Multi-Source Query + Datasource Schema Cache (v1 parity)

**Date:** 2026-06-17 · **Branch:** `fix/v2-upgrade-snapshot-id` · **Status:** Design (consensus).
**Builds on:** the v1 datasource family connectors (clickhouse/prometheus/loki/tempo/mimir + opensearch)
on `datasource_http.py` + the Connectors UI. Brings v1's NL→query + schema introspection to v2.

## Problem / Goal
v1 let the AI query multiple observability datasources in natural language, generating the right query
language (PromQL/LogQL/TraceQL/SQL) per source, using introspected schemas (`datasource-schema.ts`).
v2 has the connectors + the agent does NL→query via tool-use, but (a) the agent lacks **query-language
guidance + multi-source correlation** instructions, and (b) it must **re-introspect** schemas each time
(no cache; we can't hardcode every open-source version's schema). Add: a **durable schema cache** +
**AI-query guidance**, so an incident question fans out across configured sources with accurate queries.

## Decisions (from user)
- **Schema store = Aurora** table `datasource_schemas` (durable, BFF-managed).
- **Refresh = on-demand** via a Connectors UI "Refresh schema" button; the **agent reads the cache**
  (no agent→Aurora — the chat route injects the cached schema into the agent payload context).

## Architecture
```
[Refresh] Connectors UI "Refresh schema" → POST /api/integrations/schema {slug} (admin)
   → BFF invokes the <slug>-mcp Lambda tool `<ds>_schema` (reuses its discovery + SSRF + VPC)
   → normalized schema JSON → UPSERT datasource_schemas(account_id, slug, kind, schema, fetched_at)
[Query] chat (monitoring/data) → chat route reads datasource_schemas for CONFIGURED datasources
   → injects a compact "## Datasource schemas" block into the agent payload (bounded)
   → agent (guided by the monitoring/data system prompt) generates PromQL/LogQL/TraceQL/SQL per source,
     calls the connector query tools, correlates → answer
```

## Components
### (a) `terraform/v2/foundation/migrations/<ULID>_datasource_schemas.sql`
- Table `datasource_schemas (account_id text, slug text, kind text, schema jsonb, fetched_at timestamptz,
  PRIMARY KEY (account_id, slug))`. Idempotent ULID migration; PG17 itest.

### (b) per-connector `<ds>_schema` tool (introspection)
- Add a `<ds>_schema` tool to each connector Lambda, returning a NORMALIZED, BOUNDED schema:
  - `clickhouse_schema` → `{tables:[{name, columns:[{name,type}]}]}` (SHOW TABLES + DESCRIBE; cap tables/cols).
  - `prometheus_schema`/`mimir_schema` → `{metrics:[…], labels:[…]}` (`/labels` + `/label/__name__/values`; cap).
  - `loki_schema` → `{labels:[…]}` (+ optionally values for a few labels; cap).
  - `tempo_schema` → `{tags:[…]}` (`/api/search/tags`; cap).
  - `opensearch_schema` → `{indices:[…], fields:{…}}` (cat indices + a sample mapping; cap).
  - All reuse the connector's own `_get`/`load_datasource`/`assert_host_allowed`; byte/count-bounded.

### (c) `web/lib/datasource-schema.ts` + `web/app/api/integrations/schema/route.ts`
- lib: `getSchema(accountId, slug)`, `upsertSchema(...)`, `listConfiguredSchemas(accountId)` (Aurora node-pg).
- route (admin): `POST {slug}` → resolve fn name `${project}-agent-${slug}-mcp` → `LambdaClient.invoke`
  `{tool_name:'<slug>_schema'}` → parse → `upsertSchema`. `GET ?slug=` (or all) → `{slug, kind, fetched_at,
  summary}` (counts only; full schema available to the chat route server-side). isAdmin-gated; SSRF N/A
  (the Lambda owns it). Bound stored schema size.

### (d) `web/app/customization/page.tsx`
- Per datasource Connectors card: a **"Refresh schema"** button (calls `POST /api/integrations/schema`)
  + show `fetched_at` + a count summary (e.g. "12 tables" / "340 metrics"). Disabled until configured.

### (e) `agent/agent.py` (monitoring + data system prompts) + `web/lib/agent-resolver.ts` / chat route
- **Prompt guidance** (port v1 `datasource-prompts.ts`): the monitoring/data system prompt lists the
  datasource tools + query languages (PromQL/LogQL/TraceQL/SQL) + WHEN to use which + a multi-source
  **incident correlation** pattern (metrics→logs→traces). Tells the agent to use the provided schema.
- **Schema injection:** the chat route reads `listConfiguredSchemas(accountId)` and adds a bounded
  "## Datasource schemas (cached)" block to the agent payload context (reuse the inc2 integration-context
  injection path). No agent→Aurora.

### (f) `scripts/v2/agentcore/catalog.py` + `terraform/v2/foundation/ai.tf`
- catalog: add the `<ds>_schema` tool to each datasource target's tool list.
- ai.tf: grant the **web task role** scoped `lambda:InvokeFunction` on `${project}-agent-*` (integ-gated)
  so the refresh route can invoke the connector Lambdas. No other IAM.

## Error handling
- Refresh: Lambda invoke error / connector "not connected"/SSRF → 400 with the connector's message; partial
  schema (some tables fail) → store what succeeded + a note.
- Query: stale/missing schema → the agent still works (it can call discovery tools or query without schema).

## Testing
- migration itest (PG17, idempotent). `<ds>_schema` unittest per connector (introspection + bounding).
- `datasource-schema.test.ts` (upsert/get/list, size bound). `schema/route.test.ts` (admin-gate, invoke→store,
  GET summary has no secret/raw-value leak). agent prompt: a unit asserting the monitoring prompt names the
  datasource query languages. chat-route schema-injection test. web vitest + TF validate green.

## Scope / YAGNI
- Read-only introspection + cache + prompt guidance. No auto-refresh/scheduling, no NL→query *pre*-generation
  (the agent generates at query time), no schema diffing/versioning. The agent already fans out (hybrid
  router parallel synthesis) — this adds accuracy (schema) + guidance, not a new orchestration engine.

## ADR note
Read-only schema introspection + cache + query guidance for read-tier datasources (ADR-011 lineage). No
mutation/autonomy; the read-only stance holds.
