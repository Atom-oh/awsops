---
sidebar_position: 1
title: Datasources
description: Connect observability providers, verify access, and explore evidence with read-only queries
---

# Datasources

Open **Integrations → Datasources** to register observability endpoints and open an instance's **Explore →** page. Multiple instances of the same provider are supported. A saved configuration, a successful connection test, and a healthy workload are different states.

**Access and scope** Authenticated users can list configured instances, use Explore, and request AI query drafts. Administrators create, edit, delete and choose defaults, manage credentials, and run connection probes. Endpoint/settings details are shown only to administrators. Registration is global. Changing the sidebar account does not switch the selected datasource endpoint; Explore queries the selected instance ID. The first instance of a kind becomes its default. The default marker is a selection preference, not a connectivity or health result.

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
4. Optionally set Timeout (integer seconds 1–60, default 10) and a ClickHouse Database (identifier, at most 128 characters; no `system`/`information_schema`).
5. Select **Test Connection** and inspect success/failure and, on success, round-trip latency. Datadog validates both API-key validity and application-key metric-query access. An empty query result can still be a successful probe.
6. Select **Save**, then open **Explore →** and run a small read-only query to verify the intended dataset. ClickHouse `/ping`, for example, establishes reachability rather than query permission.

Testing is recommended; saving is not proof that a probe succeeded. Editing does not reveal stored secrets. Keep the endpoint and authentication method unchanged, and leave credential fields blank to retain stored values. An edit-time probe reuses only that instance's saved credentials when the entire endpoint is unchanged; changing host, scheme, port or path requires re-entry. Connection-field edits clear the previous probe result.

**None** needs no auth; **Basic** uses username/password; **Bearer token** uses a token. Dynatrace preselects token auth, sends `Authorization: Api-Token`, and needs `metrics.read`. **Custom header** allows two name/value pairs; Host, Content-Length and Authorization overrides are blocked. Datadog preselects **API key** / **Application key**, sent as `DD-API-KEY` / `DD-APPLICATION-KEY`. Credentials stay server-side in Secrets Manager and are not returned to the form.

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

Choose an instance, review a native query, then select **Run**. Pressing Enter in a single-line query field runs it; Ctrl+Enter runs multiline SQL. Query-example chips execute immediately, while natural-language example chips only fill the request field. Diagnostic-signal chips, when available, also run the selected query. For Prometheus/Mimir/Loki, changing a supported time range reruns the current query.

- Timeout effects differ: ClickHouse execution is capped at 55 seconds; Prometheus/Mimir Explore at 10 seconds. Other providers store the setting without applying it. Health probes have separate deadlines.
- Native queries are limited to 8,000 characters; ClickHouse Explore requests at most 500 rows. ClickHouse blocks mutations, SYSTEM/system tables and table functions. Start with `SELECT 1` or a discovered, permitted user table.

## AI query drafts, chat and diagnosis

Enter a natural-language request and select **Generate with AI**, or press Enter in that field. This fills the query editor and may show vocabulary or schema warnings. **Generation never executes the generated query**; review it and select **Run** separately. Natural-language input is bounded to 4,000 characters. Schema vocabulary may be missing, stale or partial; verify names, scope and warnings before running.

**Diagnose with AI** appears only for enabled, configured defaults of Prometheus, ClickHouse, Loki, Mimir and Tempo. It opens a prefilled `/assistant` prompt: `/observability` for Prometheus/ClickHouse, `/monitoring` for Loki/Mimir/Tempo. Review and send manually to start a fresh conversation. Native chat uses the default instance; use Explore for other instances.

**Datadog and Dynatrace support Explore and AI query drafting. Their native chat gateway targets and automatic diagnosis-report collection are not wired by default.** Jaeger also supports Explore/drafting without a native chat target or automatic report collector. Registering one of these datasources does not add those paths.

Worker-backed external evidence collection currently covers Prometheus, Mimir, Loki, Tempo and ClickHouse only when `datasource_diagnosis_enabled` and its AgentCore/integrations/workers dependencies are enabled. Registration alone does not enable collection. Unavailable or incomplete evidence must remain visible in the report.

Supported vendor-hosted MCP presets are a separate **Connectors** path, with separate credentials, deployment gates and tool allowlists. Saving a Datadog or Dynatrace datasource does not activate its hosted MCP. There is no `datasource` chat route or live Steampipe chat-query path in v2.

## Troubleshooting and safe use

- For authentication or timeout failures, check the API site/environment, read scopes and connector reachability, then narrow the query/window. A metric probe does not verify Problems API access.
- HTTP(S) datasource endpoints may be private. Metadata, loopback, link-local and other blocked special addresses remain prohibited; redirects and unsafe URL forms are rejected. There is no v2 Allowed Networks exception editor.
- On read/save/delete/default-selection failure, use the error and retry. Truncated, partial, stale, unassessed or empty results do not establish health; inspect the source/window and request narrower evidence.

Related guides: [Custom agents and skills](../operations/custom-agents) · [AI assistant](../overview/assistant) · [AI diagnosis reports](../operations/ai-diagnosis)
