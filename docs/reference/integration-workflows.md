# Integration Workflows

Policy: [ADR-007](../decisions/007-external-data-integration-governance.md) and
[ADR-017](../decisions/017-curated-official-mcp-presets.md). Registration, deployed
availability, successful reads and external delivery are separate facts.

## Evidence sources

`/integrations?tab=datasources` manages typed observability instances. Secrets
stay server-side; the instance ID selects credentials. Connection tests use the
same endpoint and authentication inputs as the form, and reuse stored credentials
only for the unchanged endpoint, including its path. Editing connection fields
invalidates earlier and pending test results.

Legacy default rows may reuse the kind's default credential mirror only when
there is no instance credential entry and the saved endpoint matches exactly.
SQL-backfilled default rows with a null endpoint can recover that endpoint from
the mirror; the same URL validation still applies. Explicit endpoints are never replaced.
This appears as "Default connection only"; testing and saving the instance
establishes its own configuration. Other rows cannot borrow that mirror.

The list reports saved configuration, not a network probe. Database or secret
read failures are unavailable, not a healthy empty inventory. Probe errors are
classified without reflecting upstream responses that might contain credentials.

| Provider | Implemented datasource API | Probe |
|---|---|---|
| Datadog | Metric query/discovery with API and Application keys | API-key validation plus a one-minute metric query to check application-key permissions |
| Dynatrace | Metrics API v2 `metricSelector` and problems; no Grail DQL | Metrics listing; Problems API permissions require a separate scope |
| Prometheus/Mimir | PromQL | Health/readiness; verify actual query access in Explore |
| Loki/Tempo | LogQL/TraceQL | Readiness |
| ClickHouse | Guarded read-only SQL | Ping; verify query access in Explore |
| Jaeger | Service/trace reads | Services API |

Explore and AI query drafting support more providers than the chat gateway and
scheduled diagnosis collector. Datadog/Dynatrace datasource registration does not
create a native chat target or deterministic diagnosis signals. Hosted MCP is
a separate credential namespace and gate; the checked-in Dynatrace hosted tool
allowlist is empty. Datadog and New Relic have enumerated read-tool allowlists;
do not infer their live availability from token storage.

AWS's [MCP target documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html),
checked 2026-09-13, includes API-key providers among supported outbound
authorization strategies. Older guidance excluding API keys for all MCP targets
is stale. Vendor credential type, endpoint, provisioning and tool filtering still
need their own verification.

## Knowledge and report destinations

Notion has read/search tools on `external-obs`. The credential cache expires after
60 seconds and is invalidated on an authentication failure. The administrator
probe rereads the latest saved token and checks bot authentication without
returning identity data. Page sharing is separate; authentication does not prove
access to a particular page. Notion content is not automatically collected into
every diagnosis report.

The report detail response builds manual handoff drafts from the existing
ownership-checked artifact. Selected, bounded narrative is redacted; raw inventory,
tables, code and account dumps are omitted. Missing evidence, partial reports and
truncation remain explicit. Users preview, copy or download the draft. Template
instructions are English; excerpts retain the source report's language.

| Destination | Purpose | Current delivery |
|---|---|---|
| Notion / Wiki / Confluence | Durable investigation summary and follow-up ownership | Manual draft; no page-publishing adapter |
| Slack | Short investigation update and evidence reference | Manual draft; the separate governed Slack action remains gated |
| AWS DevOps Agent | Timeline, competing hypotheses and missing operational evidence | Manual investigation context; no agent invocation |
| AWS Security Agent | Trust boundary, exposure evidence and unassessed controls | Manual review context; no scan or agent invocation |
| FinOps review | Billing period, utilization, commitments and reliability constraints | Manual review context; not measured savings or automated purchases |

These destinations do not grant export approval. The draft redactor is conservative
and best effort; the operator reviews both content and audience. No new external
write gate, AWS mutation permission or arbitrary MCP registration is enabled.

## Custom agents and skills

`/customization` uses the existing catalog. Custom records start disabled; skills
are enabled and attached in an explicit order. The current form exposes effective
persona, gateway, keyword and instruction settings rather than ignored lifecycle,
multi-gateway or model controls. The chat command catalog returns only enabled
custom-agent names for the selected registered account, behind hybrid routing;
the chat execution path remains authoritative for scope and enablement.

Save the Agent Space after account assignment or policy changes. Instruction-only
skills retain the native gateway's read tools; explicit skill policies and account
caps narrow that set. A revoked or empty policy intersection does not silently
restore tools. If the catalog or account policy cannot be read, custom-agent
execution is unavailable; built-in help remains usable with a visible fallback.
Curated integration controls remain available, but arbitrary custom MCP does not.

## Rollout and verification

MCP Lambda code ships with the reviewed Terraform deployment. Runtime changes
ship with `make agentcore`; the web application ships with `make deploy`. Observe
each component's normal prerequisites and verify deployed versions before
claiming an end-to-end connection. This change does not enable existing feature
gates or supply vendor credentials.

Use the focused datasource, credential, custom-agent, chat, report-ownership and
provider tests, followed by the production build and required CI. Browser fixture
checks establish rendered interaction behavior, not live SaaS connectivity.
