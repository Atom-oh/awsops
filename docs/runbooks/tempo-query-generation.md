# Tempo query generation

## Symptoms

Explore generates a query with an invalid attribute scope or literal type, or keeps asking for a schema refresh without finding the requested attributes.

Distinguish a generation error, `could not generate a valid query: TraceQL ...` (HTTP 502), from `Tempo HTTP 400` after the user executes a generated draft.

## Candidate causes

- The web app, Tempo connector Lambda, and schema cache have not all been updated.
- Empty results with `names_truncated: true` or `truncated: true` indicate incomplete discovery, not a confirmed empty observation; a proxy's HTML error response can cause this state.
- Schema discovery samples the last **hour**. AWSops's Tempo Explore currently has no time-range control and searches the last hour. Attributes present only in older traces may be absent from this cache.
- `attributes` contains custom attributes only; the v2 response's `intrinsic` scope is omitted. A response containing only intrinsics does not establish custom-attribute availability. The web app validates custom names and types in generated queries.
- Type sampling covers only the four discovered attributes `span.http.status_code`, `span.http.response.status_code`, `resource.service.name`, and `span.service.name`, retaining types from at most 32 values each. Sample values are neither returned in the schema nor cached; limited or missing samples cannot establish a definitive type.

Neither name nor type discovery requests `maxStaleValues` early termination, so repeated values do not hide later names or types. Name requests have a **12-second** timeout; each type request has a **4-second** timeout. Count and response-size caps remain, so discovery does not guarantee a complete schema inventory.

## Verification

**The Integrations UI has no schema-refresh control.** An authenticated admin can call `GET /api/integrations/schema` for cached summaries shaped as `{ schemas: [...] }`. Check each row's `integrationId`, `kind`, `fetched_at`, and `summary`. The browser command under Action performs this GET before and after refreshing.

In refreshed summaries, `attributes` is a **count** of custom attributes. `names_truncated`, `types_truncated`, and `truncated` are booleans for name-discovery limits, type-sampling limits, and their combined state. Refresh older caches with absent fields; absence does not mean `false`. This API exposes neither full schema names/types nor raw sample values, and the UI does not provide that inspection.

Observed attributes remain usable for AI generation even when name discovery is limited. If a requested attribute is absent from that inventory, generation returns explicit discovery-limit guidance without retrying the model against the same incomplete evidence. Name discovery currently retains at most **200 custom attributes and 64 kB (64,000 bytes)** from the last hour, so an unobserved name does not prove absence. Refreshing can hit the same limits. Verify that attribute through the Grafana/Tempo API paths below, then use a manually reviewed query.

Inspect actual names/types in traces through **Grafana Explore** on the same datasource, or through an approved Tempo API access path. Use the v2 tag-name API `/api/v2/search/tags` and typed-value API `/api/v2/search/tag/<URL-encoded TraceQL identifier>/values` with matching `start` and `end` bounds (Unix seconds). Specify those bounds on `/api/search` for historical traces too. `{ duration > 500ms }` works without an attribute schema; it is not a substitute for an HTTP 500 filter.

### Draft validation errors

The web app uses a pinned Grafana TraceQL parser, then checks observed custom
attribute names, compatible literal types, and the requested status value for
complete affirmative HTTP templates such as `HTTP 500 spans`.

- Every OR result branch must retain the requested value. Within an AND branch
  that references a standard HTTP-status attribute, a standard predicate must
  prove that value; an unrelated custom value of 500 cannot override HTTP 404.
- An observed nonstandard attribute can be a candidate only in an equality
  comparison with the requested value. Its HTTP meaning still needs user review.
  Extra context, negation, ranges, and general language are not covered by this
  template recognizer.
- Syntax, schema, or status-filter failures get one correction request, for at
  most two generations. A second invalid draft returns HTTP 502 without searching
  Tempo. `SCHEMA_REQUIRED`, unobserved names in a truncated name inventory, and
  missing HTTP-status evidence go directly to schema/manual-query guidance.
- Recognized prefix/suffix qualifiers are `today` and `yesterday` in English or
  Korean, plus `last hour`, `last day`, and `last week` in English only. They
  preserve the status predicate; they do not change execution time bounds.

- `TraceQL syntax error at character ...`: check scopes, quoting, and operators. The pinned parser does not cover every server version; verify newer syntax through Grafana Explore on the same Tempo.
- `TraceQL schema mismatch`: verify the observation window, names, and types using the API procedure above, refreshing when needed. `.key` can match span/resource observations; event/link/instrumentation retain explicit scopes.
- `TraceQL HTTP-status filter is missing or broadened`: preserve the requested status code when regenerating or manually enter reviewed TraceQL. `status = error` or `{}` does not preserve an HTTP 500 condition.

After refresh, regenerate `HTTP 500 spans` and check that the draft preserves 500
using an observed HTTP-status attribute and compatible literal type.
An `&&` query may validly combine service and HTTP conditions on separate spans.
Successful generation does not guarantee server acceptance; review the draft and
inspect the execution error/server version if Tempo still returns HTTP 400.

Local regression checks, from the repository root:

```bash
(cd agent/lambda && python3 -m pytest test_tempo_mcp.py -q)
(cd web && npx vitest run lib/tempo-schema.test.ts lib/datasource-schema.test.ts lib/datasource-querygen.test.ts app/api/datasources/generate/route.test.ts app/api/integrations/schema/route.test.ts)
bash scripts/v2/merge-verify.sh
```

## Action

A confirmed empty custom-attribute cache uses a **60-second TTL**. After expiry, the next generation request can trigger background rediscovery; this is not a timer that polls every 60 seconds. Incomplete empty results are eligible for rediscovery without waiting for that TTL. Tempo background refreshes use a one-minute per-instance cooldown to avoid per-request retries while retaining the short confirmed-empty TTL. The admin POST below performs an immediate refresh without waiting for expiry.

For an existing v2 deployment, the operator reviews the Terraform plan for the approved release. `aws_lambda_function.agent["tempo-mcp"]` in `ai.tf` packages the connector and shared HTTP module. Resolve unexpected changes before applying.

```bash
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out=tfplan
terraform -chdir=terraform/v2/foundation show tfplan
```

After reviewing the saved plan, the controller applies it and deploys the web app and AgentCore in order. Run `make agentcore` after `make deploy` has completed its prerequisite `make migrate`:

```bash
terraform -chdir=terraform/v2/foundation apply tfplan
make deploy
make agentcore
```

`make deploy` ships the web app. **`make agentcore` is required for this change** because it also updates Tempo tool descriptions in `scripts/v2/agentcore/catalog.py`. The provisioner fingerprints tool names, descriptions, and input schemas and reconciles the descriptions on existing gateway targets. Neither command replaces Terraform's connector Lambda code deployment. Existing permissions and feature flags do not need changing.

The Tempo catalog-hash change also affects the `datasource_index` job. It runs on Lambda and is included in the shared `workers_src` ZIP in `workers.tf`. Verify that the Terraform plan also updates the worker Lambda code; other Lambda functions sharing that ZIP may receive the same code-hash update. This change does not require deploying the Fargate worker image with `make workers`.

After deployment, open DevTools Console in an AWSops tab **signed in as an admin** and run this entire block. It uses the same-origin session cookie; no pasted token or domain is needed. It first lists configured Tempo instances and existing cache summaries. Enter the target instance's positive integer ID at the prompt to send **`{ id }`** to `POST /api/integrations/schema`, then read GET again to compare summaries and `fetched_at`. Canceling sends no POST.

```javascript
(async () => {
  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...options.headers },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${path}: HTTP ${response.status}; expected JSON. Check sign-in and proxy responses.`);
    }
    if (!response.ok || body?.error) {
      throw new Error(`${path}: HTTP ${response.status}: ${body?.error || response.statusText}`);
    }
    return body;
  }
  async function readSchemas() {
    const body = await requestJson('/api/integrations/schema');
    if (!Array.isArray(body?.schemas)) throw new Error('Invalid cached-schema response');
    return body.schemas;
  }
  function summaryRow(stage, row) {
    return {
      stage, integrationId: row.integrationId, fetched_at: row.fetched_at ?? null,
      tags: row.summary?.tags ?? null,
      attributes: row.summary?.attributes ?? null,
      names_truncated: row.summary?.names_truncated ?? null,
      types_truncated: row.summary?.types_truncated ?? null,
      truncated: row.summary?.truncated ?? null,
    };
  }

  const configured = await requestJson('/api/datasources');
  if (!Array.isArray(configured?.datasources)) throw new Error('Invalid datasource response');
  const tempo = configured.datasources.filter((row) => row.kind === 'tempo');
  console.table(tempo.map(({ id, name, kind }) => ({ id, name, kind })));
  const before = await readSchemas();
  console.table(before.filter((row) => row.kind === 'tempo').map((row) => summaryRow('before', row)));

  const input = prompt('Tempo datasource ID to refresh (positive integer; Cancel to stop):');
  if (input === null) return;
  const value = input.trim();
  const id = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new Error('Enter a valid positive integer datasource ID');
  }
  if (!tempo.some((row) => Number(row.id) === id)) throw new Error('ID is not a listed Tempo datasource');

  const refreshed = await requestJson('/api/integrations/schema', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (refreshed?.ok !== true || refreshed.id !== id || refreshed.kind !== 'tempo') {
    throw new Error('Unexpected schema-refresh response');
  }
  console.log('POST summary:', refreshed.summary);
  const after = (await readSchemas()).find((row) => row.integrationId === id && row.kind === 'tempo');
  if (!after || !Number.isFinite(Date.parse(after.fetched_at))) {
    throw new Error('Refreshed cache row or fetched_at is missing');
  }
  const previous = before.find((row) => row.integrationId === id && row.kind === 'tempo');
  console.table([
    summaryRow('before', previous ?? { integrationId: id }),
    summaryRow('after', after),
  ]);
  if (previous && Date.parse(after.fetched_at) <= Date.parse(previous.fetched_at)) {
    console.warn('fetched_at did not advance; verify the selected deployment and refresh result.');
  }
})().catch((error) => console.error('Tempo schema refresh failed:', error.message));
```

For 401, check sign-in; for 403, check admin access. HTML instead of JSON, redirects, or network failures require checking the login or proxy path. Investigate POST errors for connection, authentication, or response problems before retrying. A successful refresh advances the GET timestamp even if counts are unchanged. Check the booleans as well: `attributes: 0` and incomplete discovery are different states. If summary fields remain absent after refresh, verify the deployed web and connector versions.

Schema refresh also requests indexing when datasource diagnosis is enabled. Tempo's signal, graph, and card catalogs depend only on successful introspection, so sampled types, limit markers, and changing recent-window attributes do not rebuild identical content. Switching from the old full-schema hash can rebuild once; catalog versions and the corresponding generation flags still invalidate it. The full cache for query generation continues to refresh.

If the recent window remains empty, repeated refreshes cannot recover historical attributes. Use **Grafana Explore or Tempo's search API with explicit `start` and `end`** for historical queries. Manually entering TraceQL in AWSops still searches only the last hour. Use suitable intrinsic filters for recent queries and refresh after new traces arrive. AI generation returns a draft and never executes a search automatically.

## Related files

- `agent/lambda/tempo_mcp.py`
- `web/lib/tempo-schema.ts`
- `web/lib/tempo-schema.test.ts`
- `web/lib/datasource-schema.ts`
- `web/lib/datasource-querygen.ts`
- `web/app/api/datasources/generate/route.ts`
- `web/app/api/integrations/schema/route.ts`
- `web/app/api/integrations/schema/route.test.ts`
- `scripts/v2/agentcore/catalog.py`
- `scripts/v2/agentcore/provision.py`
- `scripts/v2/workers/datasource_index.py`
- `scripts/v2/workers/diagnosis/signal_catalog.py`
- `scripts/v2/workers/graph_catalog.py`
- `scripts/v2/workers/card_catalog.py`
- `terraform/v2/foundation/ai.tf`

Related decisions: **ADR-005 freezes AWS-resource mutation and autonomy**. **ADR-007 permits external data reads and governed external writes**; this procedure reads Tempo data only. The controller's approved release deployment does not enable autonomous product remediation. See the local [ADR-005](../decisions/005-aws-mutation-autonomy-frozen.md) and [ADR-007](../decisions/007-external-data-integration-governance.md) decision records.

Consult [BASELINE](../decisions/BASELINE.md) for the current operating posture.
