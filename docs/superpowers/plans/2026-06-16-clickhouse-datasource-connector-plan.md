# Plan: ClickHouse datasource connector + shared datasource-connector foundation

> Spec: `docs/superpowers/specs/2026-06-16-clickhouse-datasource-connector-design.md`. First of the v1
> datasource family (clickhouse/prometheus/loki/tempo/mimir). This increment = ClickHouse (read-only
> SQL) + the reusable foundation (`datasource_http.py`, multi-field Connectors UI, VPC flag) so the
> other four land as small siblings. User-supplied endpoint + auth; data gateway. Branch
> `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- v1 `src/lib/datasource-client.ts`: `buildHeaders` (basic = `Authorization: Basic base64(user:pass)`,
  bearer = `Authorization: Bearer token`), `fetchWithTimeout`; endpoints `/api/v1/query[_range]` (Prom),
  `/loki/api/v1/query_range` (Loki). Port to Python.
- Single integrations secret + `agent_lambda_integrations_secret` GetSecretValue grant already exist
  (credential-UI increment) → connector Lambdas read the secret with NO new IAM.
- MCP Lambda contract (network_mcp.py): `tool_name`+`arguments`, pop `target_account_id`, `ok`/`err`.
- `opensearch_vpc_enabled` + dynamic `vpc_config` + compound-gated ENI policy (ai.tf) — extend to clickhouse.
- Credential UX: `web/lib/integration-credentials.ts` stores an arbitrary object per slug; `KNOWN_CONNECTOR_SLUGS`;
  `web/app/customization/page.tsx` `CONNECTORS` (currently single `token` field) + `web/lib/ssrf-guard.ts`.

## Non-goals
- Prometheus/Loki/Tempo/Mimir tools (next increments, reuse `datasource_http`). No write, no NL→query, no schema-cache.

## Tasks (TDD; per-task commit; `python3 -m unittest` / vitest / catalog_check / `terraform validate` green)

### Task 1: shared datasource-connector helper (TDD)
**Files:**
- Create: `agent/lambda/datasource_http.py`
- Test: `agent/lambda/test_datasource_http.py`
- [ ] Failing tests (unittest; mock the single-secret read + urlopen; no network):
  - `load_datasource('clickhouse')`: reads `INTEGRATIONS_SECRET_NAME` JSON → `map['clickhouse']`
    `{endpoint,username,password}`; missing slug/empty secret → `NotConnected` (clear message).
  - `auth_headers`: `{username,password}` → `Authorization: Basic base64(u:p)`; `{token}` → `Bearer`;
    neither → no auth header.
  - `assert_host_allowed`: `169.254.169.254`/`127.0.0.1`/`::1`/`fe80::1`/`224.0.0.1`/`fd00:ec2::254`
    → blocked (raises); `10.0.0.1`/`192.168.1.1`/`fc00::1`/`8.8.8.8`/a hostname → allowed. Two
    classifiers (always-block vs allowed), NOT one. (Port agent.py `_ip_always_blocked` logic.)
  - `http_json(method,url,headers,body,timeout)`: builds the request, returns (status, parsed); HTTP
    non-2xx → (status, body) not an exception.
- [ ] Implement `agent/lambda/datasource_http.py`: `NotConnected(Exception)`; `load_datasource(slug)`
  (boto3 SecretsManager get + json + slug extract, module-cached client); `assert_host_allowed(endpoint)`
  (resolve host; `ipaddress` always-block set; DNS-resolve a hostname to its IPs and check each, else
  allow public/private); `auth_headers(creds)`; `http_json(...)` via stdlib urllib. Stdlib + boto3 only.
- [ ] `cd agent/lambda && python3 -m unittest test_datasource_http` → green.
- [ ] Commit: `feat(agent-platform): datasource_http — shared SSRF/auth/HTTP helper for v1 datasource family`.

### Task 2: ClickHouse read-only MCP Lambda (TDD)
**Files:**
- Create: `agent/lambda/clickhouse_mcp.py`
- Test: `agent/lambda/test_clickhouse_mcp.py`
- [ ] Failing tests (mock `datasource_http.load_datasource` + `urlopen`):
  - read-only guard `_assert_read_only`: accept `SELECT`/`WITH…SELECT`/`SHOW`/`DESCRIBE`/`DESC`/`EXISTS`
    (case/whitespace-insensitive); reject `INSERT`/`ALTER`/`DROP`/`CREATE`/`DELETE`/`TRUNCATE`/`OPTIMIZE`/
    `ATTACH`/`SET`/`SYSTEM` and any multi-statement (`;` separating statements) → error before any request.
  - `clickhouse_query('SELECT 1', max_rows=5)`: POST `<endpoint>/?readonly=1&max_result_rows=5` with the
    Basic-auth header and `FORMAT JSON` appended; returns parsed rows; truncates to max_rows.
  - `clickhouse_tables` → `SHOW TABLES`; `clickhouse_describe('t')` → `DESCRIBE TABLE t`.
  - not connected (load_datasource raises) → structured error; HTTP 4xx/5xx → structured error w/ snippet.
  - SSRF: a blocked endpoint (via assert_host_allowed) → "endpoint blocked" error; `target_account_id` popped.
- [ ] Implement `agent/lambda/clickhouse_mcp.py`: `lambda_handler` (mirror dispatch); uses
  `datasource_http.load_datasource('clickhouse')` + `assert_host_allowed` + `auth_headers` + `http_json`;
  `_assert_read_only(sql)`; 3 tools; `readonly=1`+`max_result_rows`; `ok`/`err`; row truncation.
- [ ] `cd agent/lambda && python3 -m unittest test_clickhouse_mcp` → green.
- [ ] Commit: `feat(agent-platform): ClickHouse read-only MCP Lambda (SQL, read-only guard) on datasource_http`.

### Task 3: multi-field Connectors UI + clickhouse slug + endpoint SSRF on save
**Files:**
- Modify: `web/lib/integration-credentials.ts`
- Test: `web/lib/integration-credentials.test.ts`
- Modify: `web/app/api/integrations/credential/route.ts`
- Test: `web/app/api/integrations/credential/route.test.ts`
- Modify: `web/app/customization/page.tsx`
- [ ] Add `clickhouse` to `KNOWN_CONNECTOR_SLUGS`. Failing tests: store/merge a multi-field
    `{endpoint,username,password}` under `clickhouse` (other slugs preserved); `getConfiguredSlugs`
    still keys-only. Route: a `clickhouse` PUT whose `secret.endpoint` resolves to a blocked host
    (metadata/loopback) → 400 (SSRF-rejected, no SM write); a valid endpoint → stored.
- [ ] Implement: route (or a lib helper) SSRF-validates `secret.endpoint` for endpoint-bearing slugs via
    `web/lib/ssrf-guard.ts` always-block set (private allowed) before `setIntegrationCredential`.
- [ ] `page.tsx`: generalize `CONNECTORS` to `{slug,label,help,fields:[{key,label,secret?}]}`; render each
    field; PUT `{slug, secret:{...collected}}`. Notion = `[{token}]`; ClickHouse =
    `[{endpoint},{username},{password,secret:true}]`. Never render secret values back.
- [ ] `cd web && npx vitest run lib/integration-credentials.test.ts app/api/integrations/credential/route.test.ts`
    → green; `npx tsc --noEmit` adds no errors in the changed files.
- [ ] Commit: `feat(integrations): multi-field Connectors UI + clickhouse slug + endpoint SSRF on save`.

### Task 4: register the ClickHouse target on the data gateway
**Files:**
- Modify: `scripts/v2/agentcore/catalog.py`
- [ ] `TARGETS["clickhouse-mcp-target"]` → `{gateway:"data", lambda_key:"clickhouse-mcp", tools:[3]}`:
    `clickhouse_query` (req `sql`; opt `max_rows`), `clickhouse_tables` (none), `clickhouse_describe` (req `table`).
- [ ] `cd scripts/v2/agentcore && python3 catalog_check.py` → `OK` + `clickhouse-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register clickhouse-mcp-target on data gateway`.

### Task 5: provision the ClickHouse Lambda + clickhouse_vpc_enabled flag (TF)
**Files:**
- Modify: `terraform/v2/foundation/ai.tf`
- [ ] Add `"clickhouse-mcp"` to `local.agent_lambdas` base map (agentcore_enabled). NO new IAM (reuses
    `agent_lambda_integrations_secret` GetSecretValue; ClickHouse is plain HTTP — no AWS data IAM).
- [ ] Add var `clickhouse_vpc_enabled` (bool, default false). Extend the dynamic `vpc_config` condition to
    `(each.key == "opensearch-mcp" && var.opensearch_vpc_enabled) || (each.key == "clickhouse-mcp" && var.clickhouse_vpc_enabled)`,
    and the ENI policy gate to `var.agentcore_enabled && (var.opensearch_vpc_enabled || var.clickhouse_vpc_enabled)`.
- [ ] `terraform -chdir=terraform/v2/foundation fmt` (revert out-of-scope drift) + `validate` (flag off AND
    `-var clickhouse_vpc_enabled=true`) → green.
- [ ] Commit: `feat(agent-platform): provision clickhouse-mcp Lambda + clickhouse_vpc_enabled flag (off)`.

## Manual / live steps (NOT autonomous)
1. `terraform -target` apply: clickhouse Lambda (+ VPC if `clickhouse_vpc_enabled=true`).
2. `make deploy` (Connectors multi-field UI) + `make agentcore` (clickhouse-mcp target on data gateway).
3. Connectors → ClickHouse: enter endpoint + user/password → chat (data) "ClickHouse: SELECT … last hour".
   (No live ClickHouse → code/tests only until a reachable endpoint exists; in-VPC needs the flag.)
