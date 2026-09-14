---
sidebar_position: 1
title: Datasources
description: Connect observability providers, verify access, and explore evidence with read-only queries
---

# Datasources

Open **Integrations → Datasources** to register observability endpoints and open an instance's **Explore →** page. Multiple instances of the same provider are supported. A saved configuration, a successful connection test, and a healthy workload are different states.

## Access and scope

- Authenticated users can list configured instances, use Explore, and request AI query drafts.
- Administrators create, edit, delete and choose defaults, manage credentials, and run connection probes. Endpoint/settings details are shown only to administrators.
- Registration is global. Changing the sidebar account does not switch the selected datasource endpoint; Explore queries the selected instance ID.
- The first instance of a kind becomes its default. The default marker is a selection preference, not a connectivity or health result.

## Supported providers

| Provider | Explore query | Connection probe |
|---|---|---|
| Prometheus | PromQL, for example `up` | `/-/healthy` |
| Mimir | PromQL, for example `up` | `/ready` |
| Loki | LogQL, for example `{job="varlogs"} \|= "error"` | `/ready` |
| Tempo | TraceQL, for example `{ duration > 500ms }` | `/ready` |
| ClickHouse | Read-only SQL; start with `SELECT 1` | `/ping` |
| Jaeger | Service name or parameters such as `service=frontend&limit=20` | `/api/services` |
| Dynatrace | Metrics API v2 `metricSelector`, for example `builtin:host.cpu.usage:avg` | `/api/v2/metrics?pageSize=1` |
| Datadog | Metric query, for example `avg:system.cpu.user{*}` | `/api/v1/validate`, then a one-minute `/api/v1/query` |

Use metric, label, service and table names that exist in your environment. Jaeger Explore returns compact trace-search results; it does not treat a bare Trace ID as a direct trace lookup. Dynatrace uses Metrics API v2, not Grail DQL; its separate Problems tool requires `problems.read`, which the metric probe does not verify. The Datadog datasource queries metric timeseries, not logs or APM traces.

## Connect, test and save

1. Select **Add Datasource**, choose a provider, and enter a name and API base URL. The form supplies provider-specific URL hints; use the correct Datadog site or Dynatrace environment.
2. Enter authentication details. Keep credentials out of the URL; API base URLs must not contain user information, query parameters or fragments.
3. Supply **Org ID (X-Scope-OrgID)** when the backend requires it, for any connector/auth method. Blank edits preserve the tenant at the same endpoint; address changes or mismatches require credentials and the tenant again. To remove the tenant, explicitly select **Clear stored Org ID** in Edit (API: `creds: { org_id: '' }`). It starts unchecked, disables the Org ID input while checked, and is never selected automatically by an endpoint change.
4. Optionally set the query timeout and, for ClickHouse, the default database. Their effective limits are listed below.
5. Select **Test Connection** and inspect success/failure and, on success, round-trip latency. Datadog validates both API-key validity and application-key metric-query access. An empty query result can still be a successful probe.
6. Select **Save**, then open **Explore →** and run a small read-only query to verify the intended dataset. ClickHouse `/ping`, for example, establishes reachability rather than query permission.

Testing is recommended; saving is not proof that a probe succeeded. Editing does not reveal stored secrets. Keep the endpoint and authentication method unchanged, and leave credential fields blank to retain stored values. An edit-time probe reuses only that instance's saved credentials when the entire endpoint is unchanged; changing host, scheme, port or path requires re-entry. Connection-field edits clear the previous probe result.

### Authentication

| Method | Use |
|---|---|
| None | A backend that needs no authentication |
| Basic | Username and password, for example an authenticated ClickHouse endpoint |
| Bearer token | Token authentication; the Dynatrace connector sends `Authorization: Api-Token` instead of Bearer |
| Custom header | Up to two name/value pairs; transport-critical headers such as Host, Content-Length and Authorization cannot be overridden |

Choosing Datadog preselects dedicated **API key** and **Application key** fields, sent as `DD-API-KEY` and `DD-APPLICATION-KEY`. Choosing Dynatrace preselects its token field; metric access needs `metrics.read`. Credentials are stored server-side in Secrets Manager and are not returned to the form.

### Read the state correctly

| State | Meaning / next step |
|---|---|
| Saved · unverified | The required configuration is present; perform a probe and a representative query |
| Default connection only · save instance configuration | Legacy default connection only; verify the endpoint in Edit, test and save the instance |
| Endpoint setup required | Endpoint is missing or invalid; an administrator must check the HTTP(S) API base URL |
| Authentication setup needed | Required saved credential material is missing; ask an administrator to complete it |
| Connection success (Edit test) | This provider's probe succeeded; it does not certify every API permission, dataset or workload |
| Status unavailable | Configuration could not be read; retry or ask an administrator to check access rather than treating the list as empty |
| Disabled | The row is disabled; its AI diagnosis shortcut is not offered |

## Explore and query limits

Choose an instance, review a native query, then select **Run**. Pressing Enter in a single-line query field runs it; Ctrl+Enter runs multiline SQL. Query-example chips execute immediately, while natural-language example chips only fill the request field. Diagnostic-signal chips, when available, also run the selected query.

Prometheus, Mimir and Loki support **Instant** and range presets: 5m, 15m, 1h, 6h, 24h and 7d; Prometheus/Mimir also offer 30d. Changing a range reruns the current query. Other providers do not expose this range selector. Direct range requests are bounded by a 60-second minimum, a 30-day maximum for Prometheus/Mimir or 7 days for Loki, and at most 5,000 evaluation points. Native query text is limited to 8,000 characters.

| Setting / limit | Current behavior |
|---|---|
| Timeout | Integer seconds, 1–60; default 10 |
| ClickHouse timeout | Query execution ceiling across Explore, graph and agent paths; effective maximum 55 seconds. Callers may tighten it; 56–60 becomes 55. The HTTP deadline is aligned above it |
| Prometheus/Mimir timeout | Applied to Explore queries as the upstream API timeout, capped at 10 seconds below the connector's 12-second HTTP deadline |
| Other providers' timeout | Saved but not currently applied by Loki, Tempo, Jaeger, Dynatrace or Datadog |
| ClickHouse Database | Optional identifier, at most 128 characters; `system` and `information_schema` are rejected |
| ClickHouse rows | Explore requests at most 500 rows; the connector's general ceiling is 1,000. Narrow queries with a safe LIMIT |
| Query result cache | No configurable result-cache TTL; schema caching for AI vocabulary is separate |

These query settings are not a promise that every health probe uses the same deadline. ClickHouse rejects mutating statements, SYSTEM and table-function access; use `SELECT 1` or a discovered, permitted user table. Do not assume that a read-only-looking query is allowed by every backend.

Results include row/series counts, connector round-trip time and result shape. Prometheus/Mimir range charts show up to eight series, with Line/Bar selection; the data table and notices provide additional context. Loki has a log viewer; Tempo/Jaeger have compact trace results and duration bars. Check truncation, partial-coverage and empty-result notices before interpreting a chart. A small or empty result does not establish workload health or complete coverage.

## AI query drafts, chat and diagnosis

### Generate a query, then review and run

Enter a natural-language request and select **Generate with AI**, or press Enter in that field. This fills the query editor and may show vocabulary or schema warnings. **Generation never executes the generated query**; review it and select **Run** separately. Natural-language input is bounded to 4,000 characters.

Drafting uses the selected instance's available schema vocabulary. Missing, stale or partial schema may trigger a background refresh; a draft may proceed without complete schema. Verify names, time scope, permissions and warnings. The datasource's result cache and this schema cache are different concepts.

### Diagnose a default instance

For **enabled, configured default instances** of Prometheus, ClickHouse, Loki, Mimir and Tempo, **Diagnose with AI** opens `/assistant` with a prefilled, section-pinned prompt. Prometheus/ClickHouse use `/observability`; Loki/Mimir/Tempo use `/monitoring`. These are prompt section selectors. Review and send the prompt yourself; opening the link does not send it and sending starts a fresh conversation.

Native chat tools use each kind's default instance. Select another instance in Explore when you need its evidence; a non-default row does not get this diagnosis shortcut. The agent uses available connector read/query/schema tools, not a guaranteed NLB, security-group or Kubernetes diagnosis pipeline.

**Datadog and Dynatrace support Explore and AI query drafting. Their native chat gateway targets and automatic diagnosis-report collection are not wired by default.** Jaeger also supports Explore/drafting without a native chat target or automatic report collector. Registering one of these datasources does not add those paths.

Worker-backed external evidence collection currently covers Prometheus, Mimir, Loki, Tempo and ClickHouse only when `datasource_diagnosis_enabled` and its AgentCore/integrations/workers dependencies are enabled. Registration alone does not enable collection. Unavailable or incomplete evidence must remain visible in the report.

Supported vendor-hosted MCP presets are a separate **Connectors** path, with separate credentials, deployment gates and tool allowlists. Saving a Datadog or Dynatrace datasource does not activate its hosted MCP. There is no `datasource` chat route or live Steampipe chat-query path in v2.

## Troubleshooting and safe use

- For authentication failures, verify the API site/environment, authentication method and required read scopes. A successful metric probe does not establish Problems API access.
- For timeouts, verify endpoint reachability and network rules from the connector, then narrow the query/window. Private endpoints require appropriate connector network access.
- HTTP(S) datasource endpoints may be private. Metadata, loopback, link-local and other blocked special addresses remain prohibited; redirects and unsafe URL forms are rejected. There is no v2 Allowed Networks exception editor.
- For configuration read/save/delete/default-change failures, use the visible error and retry; do not infer success from an unchanged row or cached display.
- For truncated, partial, stale or unassessed evidence, inspect the source/window and narrow the request. Do not turn unavailable measurements into healthy zeroes.

## Related guides

- [Custom agents and skills](../operations/custom-agents)
- [AI assistant](../overview/assistant)
- [AI diagnosis reports](../operations/ai-diagnosis)
