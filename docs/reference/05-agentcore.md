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

## Custom tool policy

The resolver uses `web/lib/gateway-tool-catalog.json`, a qualified-name snapshot of the Python catalog's Lambda schemas and hosted-MCP read allowlists. Refresh it from those catalog entries when membership changes and run `web/lib/agent-resolver.test.ts`'s parity check. It is an eligibility catalog, not live discovery. Runtime provisioning and official-MCP gates still apply. Instruction-only skills inherit existing gateway reads unless a declared or retained restriction exists. Account caps narrow that baseline; declared/revoked empty intersections remain deny-all. An empty account cap is unrestricted at that layer; an effective `[]` denies all tools and is encoded as `!awsops-deny-all!` for older runtimes. `undefined` retains legacy unrestricted filtering. Chat discloses and persists a policy-zero limitation instead of implying live evidence was read.

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
