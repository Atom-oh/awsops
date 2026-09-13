# ADR-017: Curated Official MCP Presets

## Status

Accepted; reclassified by owner direction **2026-08-05** after the initial **2026-07-31** design.
Owner **Junseok Oh** directed curated, maintained vendor MCPs on **2026-07-29**, then clarified on
**2026-08-05** that he did not want to host/manage extra MCP servers or unusable token-only cards.
These are recorded directions, not authority to enable the frozen stdio path.
Runtime readiness behavior documented **2026-08-06**. Repository evidence checked **2026-09-13**.

## Context

Vendor-hosted endpoints and self-hosted MCP programs have different deployment/authentication models.
A generic "paste a token" interface cannot make both usable or enforce read-only behavior.

## Decision

### Hosted presets: GATED

- The checked-in catalog supports Datadog, Dynatrace, and New Relic as hosted `mcpServer` targets.
  `official_mcp_enabled`, `agentcore_enabled`, and `integrations_enabled` are required and default false.
- Endpoints remain operator data constrained by catalog `allowed_host_suffixes`. Require
  `official_mcp_read_only_ack[preset_key]` to match the exact reviewed endpoint; missing/mismatched
  configuration skips and retires the target.
- Catalog `tool_allowlist` names must be transcribed from vendor documentation with date/source,
  not guessed. Provision them into `OFFICIAL_MCP_TOOL_ALLOWLIST_JSON`; runtime tool intersection
  fails closed in both Strands and the optional Anthropic loop. Empty/unset/invalid allowlists expose
  no preset tools. The checked-in Dynatrace list is empty deliberately.
- `capability=read` and operator acknowledgement alone are insufficient. Runtime filtering closes
  the former unreviewed-vendor-tool gap; managed-egress connect-time DNS/IP validation remains a
  separate limitation, constrained by the catalog host pin.
- Provisioning waits for runtime readiness. Failure/timeout retires even otherwise-qualified hosted
  targets so an older unfiltered runtime cannot keep serving them; a later successful run restores
  them idempotently. The brief old-runtime window during an update is the recorded residual tradeoff,
  not an assertion of instantaneous revocation throughout deployment.

### ClickHouse stdio: FROZEN

`CLICKHOUSE_OFFICIAL_MCP` defaults false and is **do-not-enable** (review **2026-08-05**, PR #207).
The retained adapter would reuse the existing default ClickHouse integration credentials and run
`mcp-clickhouse` inside the agent container. Its write/drop-disabling env values do not replace
in-house table-function SSRF blocking, server `readonly=1`, or connect-time host protection.

Unfreezing requires both equivalent query/connection defenses (or an enforced least-privilege server
profile that closes the same surface) **and** a new ADR, multi-AI review, and a dated owner override.
An in-place documentation edit cannot lift this classification.

The adapter's supported credential/endpoint shape is basic/none auth and host/port, not bearer/custom
headers or path prefixes. It suppresses the in-house ClickHouse tools only after successful stdio
connection; failure retains them. Those dark implementation details are not an enabled capability.

### Other connectors

Keep Tempo's existing Lambda target and datasource registration. Jaeger's Lambda does not by itself
create a chat gateway target. Grafana/Splunk hosted connector cards and the old self-hosted presets
are removed; arbitrary `custom_mcp` remains retired. Future routing changes must match actual target
membership, not obsolete Tempo cutover instructions. Residual stored credentials/configuration from
removed presets do not prove active tools; cleanup is an operator task.

## Consequences

Hosted tools can be adopted through explicit catalog/endpoint/tool controls, with readiness failure
favoring temporary loss of integration over unfiltered exposure. The intended ClickHouse maintenance
benefit remains unavailable while frozen. General external-write governance in ADR-007 is unchanged;
this ADR is not an ADR-005 mutation exception.

## Six Pillars

Security: scoped credentials, host pins, runtime tool allowlists, and an explicit stdio freeze.
Operational Excellence/Reliability: honest connector support and fail-closed rollout behavior.
Cost: default-off infrastructure gates, without implying a cost-free foundation.

## Evidence

`scripts/v2/agentcore/{catalog,provision}.py`, `agent/agent.py`, `agent/anthropic_loop.py`,
`agent/lambda/{clickhouse_mcp,datasource_http}.py`, `terraform/v2/foundation/ai.tf`, ADR-005/007.
