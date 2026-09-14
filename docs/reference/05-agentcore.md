# AgentCore Runtime and Tools

Policy: [BASELINE](../decisions/BASELINE.md). Local contracts:
[agent](../../agent/CLAUDE.md) and [tool Lambdas](../../agent/lambda/CLAUDE.md).

## Ownership and provisioning

- [ai.tf](../../terraform/v2/foundation/ai.tf) owns images/IAM, Lambda packaging,
  configuration placeholders, and task-role access. Inspect each resource's flag;
  agent and integration gates are separate and default-off does not prove deployment.
- [catalog.py](../../scripts/v2/agentcore/catalog.py) declares gateways, Lambda
  targets, schemas, and curated MCP presets. [provision.py](../../scripts/v2/agentcore/provision.py)
  reconciles runtime/gateway/target/Memory/Interpreter resources and writes SSM.
  These registries, not prose counts, establish the tool inventory.
- `make agentcore` builds/pushes the arm64 runtime and invokes the provisioner.
  It requires the relevant Terraform infrastructure and `make migrate` first;
  migration creates/synchronizes the SQL reader. MCP Lambda code ships through
  Terraform, not the runtime image command.
- Runtime settings come from SSM `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}`.
  The BFF reads these at runtime; ECS `valueFrom` placeholders are not the config path.

Gateway reconciliation requires the deployment identity to have
`bedrock-agentcore:GetGateway` in addition to its existing list/update permissions.
The provisioner reads each existing gateway before correcting its role or description,
preserving deployed authentication, protocol and optional security configuration.
Lambda targets reconcile ARN and credential type as well as the managed tool schema.
Known gateway IDs remain available for runtime routing and ADR-017 teardown when a
read/update fails; a failed role reconciliation makes provisioning fail, while a
description-only update failure remains a warning. Gateway/target failures use fixed
diagnostic codes without raw exception details. `CREATED`/`UPDATED` means AWS accepted
the request; verify readiness and actual invocation separately. There is no automatic
delete/recreate recovery for failed resources.

## Routing and runtime

[agent.py](../../agent/agent.py) selects from discovered/configured gateways and
uses signed MCP transport. Preserve the `observability` to `external-obs` alias
and canonical/`v2-` key fallback. Host-account requests use execution credentials;
foreign targets use the shared cross-account helper.

The [chat handler](../../web/app/api/chat/route.ts) and
[route registry](../../web/lib/route.ts) define dispatch. Hybrid classification
and multi-route synthesis have independent gates. Registered local SQL/collector
keys fall back to normal routing because `steampipeAvailable()` is always false;
they are not live Steampipe query capabilities. The ops Aurora reader currently
coexists with direct domain API targets; see [inventory contracts](03-data-aurora.md).

Connection/tool-discovery failure before output can yield a tool-less answer.
After streaming begins, failures must not trigger a duplicated fallback answer.
Runtime experimental-loop selection remains server-controlled at the BFF boundary.

Custom dispatch reads one available/unavailable context from `web/lib/catalog-source.ts`.
Either policy or agent-catalog failure denies custom candidates, while built-in chat/help remain
usable. Explicit custom pins receive an unavailable response; automatic fallback is visibly
identified and persisted as a built-in answer. Confirmed no-row policies retain Phase-1 behavior.

## Optional stream evidence

The Runtime adds metadata frames alongside existing text frames:

| Field | Contract |
| --- | --- |
| `receipt` | Version 1, one bounded record per call ID, with tool identity, delivery clocks, safe requested/tool-reported scope and outcome. |
| `evidenceTruncated` | Some call evidence was omitted; consumers must not certify complete coverage. |
| `completion` | Version 1 and `receiptCount`, emitted after receipts. This closes delivery of the receipt set, not successful collection. |
| `runtimeOutcome` | `error` when the stream fails; preceding useful text does not erase that failure. |

Receipt outcomes distinguish success, confirmed empty, partial, error, unverified and unfinished
calls. Async query submission or pending status is not a completed result. Known producer freshness,
continuation and child-error signals restrict the conclusion; missing metadata does not establish
independently verified scope. Source clocks remain distinct from stream delivery clocks.

Strands success, HTTP 2xx and parseable JSON certify neither complete collection nor a confirmed
empty result. Unknown objects, arrays (including empty arrays), and empty result content default to
`unverified`. Explicit errors and recognized incompleteness still constrain the outcome. A valid but
unrecognized payload is not automatically malformed. Useful model text and raw tool data remain
unchanged; this classification governs only evidence metadata.

Positive outcomes require a recognized tool and its validated producer envelope:

| Coverage | Required evidence |
|---|---|
| Existing explicit handlers | Async terminal-query results, inventory freshness, rightsizing and the bounded shallow producer contracts |
| IAM/DynamoDB lists | Observed list fields plus typed continuation/truncation evidence; missing or malformed collection/continuation values stay unknown |
| Trusted Advisor | Observed check collection, a 15-check cap, and known finite estimates for numeric savings totals; unavailable estimates remain null/unknown |
| OpenSearch | Domain enumeration is capped at 20 with truncation disclosed; missing collection/description metadata is unknown; search validates timeout and shard evidence |
| ENI lookup/configuration | The current IPv4 lookup's typed identity and matching counts, or explicit SG/NACL/route collections with configuration completeness and route selection |
| Topology | Graph class, bounded nodes/edges and matching counts, selection/truncation, and non-stale source/publication metadata together |
| Notion | Identified records, observed results/pagination, `collectionStatus`, and separate `blocksCollectionStatus` for page children |
| Prometheus/Mimir | Bounded vector/matrix envelopes and named labels/series require upstream-derived `collectionStatus`; upstream query warnings remain partial |
| Tempo | Trace search requires an observed list and `collectionStatus`; hitting the explicit request limit (default 20) or reported unfinished jobs remains partial; existing OTLP `batches` handling remains separate |
| Loki | Validated streams/vector/matrix query envelopes and named label/value collections require upstream-derived `collectionStatus`; hitting a query's line limit remains partial |

`query_inventory` also follows the producer's registered field projections. Other resource types
retain partial outcomes with unknown field coverage, even when their count and freshness are healthy.

The source contract requires affected producers to emit typed collection status (`ok`, `empty`, `partial`, `unknown`, or a
component `error`) before coercion can erase upstream evidence. Missing or non-list collections
cannot become confirmed empty lists. Named Prometheus/Mimir/Loki lists also require an upstream
success status. Tempo search treats an omitted protobuf-style `traces` field as unknown, while
retaining returned metrics and bounded trace data.

OpenSearch search must retain nullable `timedOut` and `failedShards` fields plus `collectionStatus`;
absent or malformed flags are unknown, never false/zero. Timeouts, failed shards and omitted hits
prevent a complete result. Notion must independently record page and block collection: valid page
metadata remains useful when block retrieval fails or its results/pagination fields are absent.
Legacy responses without required source markers remain unverified or partial according to the handler;
explicit errors and disclosed incompleteness retain their restrictive outcomes. These markers require
matching payload structure before success or confirmed empty can be granted.

These are finite envelope checks, not recursive validation of resource health, metric values, span
attributes or document contents. Other tool responses, introspection formats and future encodings
remain unverified until explicitly supported; positive-looking quality fields alone do not enable
them. Bounded omission remains partial, including ENI lookups at the legacy ten-match cap.

Deploy the corresponding Lambda producer updates before expecting positive outcomes that require
these new source markers. Runtime handling alone does not upgrade a legacy producer's evidence.

The web consumer ships separately. The existing web parser ignores these optional frames; newer consumers
must preserve useful text but treat absent, malformed or incomplete evidence as unverified/partial.
Detailed receipts belong only in ownership-checked conversation metadata. Global invocation
statistics retain coarse outcomes, never raw outputs, queries, credentials or pagination tokens.
Compatible consumers must retain unverified answers and mark mixed confirmed/unverified evidence partial.
They must exclude unverified calls from the evidence-confirmed success-rate denominator. Expanding or
tightening producer coverage can therefore change that rate without a change in operational health;
compare it alongside assessed/unverified counts and the coverage policy in effect.

## Custom tool policy and registration

`web/lib/gateway-tool-catalog.json` maps approved target names to `{gateway, tools}`.
The resolver accepts unambiguous shorthand only within that gateway and emits exact `target___tool`
identities. This snapshot describes eligibility, not live discovery; runtime provisioning and
official-MCP gates still apply. Instruction-only skills without tool declarations or a retained
`toolPolicyConfigured` restriction use existing gateway reads as their baseline. Account caps narrow
that baseline. Declared or revoked restrictions keep empty intersections deny-all. An empty account
cap adds no restriction at that layer; an effective `[]` denies all tools and the wire token
`!awsops-deny-all!` also denies on old exact-match runtimes. `undefined` retains legacy unrestricted
filtering. Chat discloses and persists a policy-zero limitation instead of implying live evidence
was read. Legacy `agent-space.ts` helpers are not the live resolver.

Regenerate the JSON by projecting `catalog.py`'s `TARGETS[*].tools[*].name` and
`MCP_SERVER_TARGETS[*].tool_allowlist` into that shape, then run
`cd web && npx vitest run lib/agent-resolver.test.ts` for offline parity verification.
Restricted ClickHouse stdio vocabulary remains outside this contract while that path is FROZEN.

The customization page retains curated egress/ingress registry registration and enable/disable
controls under **Integrations (advanced)**; `custom_mcp` is excluded. New rows are disabled.
Credentials, exposed tools, source allowlists and incident/write gates require separate
configuration. Ordinary datasource and Notion credentials remain in the integrations hub.
Registration does not provision a gateway, verify connectivity or grant infrastructure permissions.

Skill attachment locks the custom agent row in a transaction, then appends after all persisted
bindings, including disabled skills. Repeated attachment preserves its existing ordinal.
The API assigns and returns that ordinal, ignoring legacy client ordering. A successful attachment
followed by a failed refresh is reported as saved with a reload notice, not as a failed attachment.

## Security and operational limits

Lambda-backed targets use `GATEWAY_IAM_ROLE`; curated vendor targets have their
own credential providers and endpoint acknowledgements. The runtime intersects
vendor tools with the configured allowlist, failing closed when it is absent.
The provisioner checks readiness before cutover; an unconfirmed runtime allowlist
can retire eligible vendor targets. Inspect the result and rerun reconciliation
instead of declaring an attempted update complete.

AWS mutation/autonomy and arbitrary BYO-MCP remain FROZEN. Curated external-data
reads/writes follow their distinct gates in BASELINE; ClickHouse stdio embedding
remains frozen. Do not infer that all external writes are AWS mutations.

The provisioner uses underscore-based Memory/Interpreter names and a 365-day
Memory expiry. Runtime updates retain role and network configuration. Source
contains compatibility and legacy tools; catalog membership plus runtime gates
establish reachability. For credential/grant troubleshooting see
[the SQL reader runbook](../runbooks/agent-sql-reader.md).

Deployment readiness is a default-off runtime mode. Applied `ci_readiness_enabled` feeds
`agentcore.deployment_readiness_enabled`; the provisioner sets DEPLOYMENT_READINESS_ENABLED
from that boolean. The probe uses fixed inventory tools, source freshness and bounded model
invocation, preserving unknown coverage and timeout evidence. App access requires admin or
deployment-verifiers. PENDING/malformed runtime ARNs are rejected before caching; an empty
runtime SSM parameter disables invocation/readiness discovery.

The curated query_inventory tool accepts optional resource_id for CloudFront only. That
branch validates the ID, binds it as a SQL parameter, scopes it to host inventory and
returns at most one id-only record. Readiness uses this exact lookup. Ordinary list calls
keep their existing projection. Deploy the reader Lambda via Terraform and refresh the
AgentCore catalog target before using this argument. The lookup itself adds no IAM grant
or activation flag.
