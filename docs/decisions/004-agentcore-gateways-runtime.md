# ADR-004: AgentCore Gateways and Runtime

## Status

Accepted **2026-06-22**. Consolidates legacy ADRs 004, 018, 027, 031 (platform phases), and 039
(platform/egress-read phases). Owner approved observability routing **2026-06-24**. SQL-reader boundary
corrected **2026-07-31**; hosted MCP controls reconciled **2026-08-05/06** under ADR-017.
Repository evidence checked **2026-09-13**.

## Context

Section-specific tools reduce irrelevant tool selection. Runtime customization needs data-driven catalogs
without allowing custom content to override safety, ownership, or tool permissions.

## Decision

### §1 Gateways and shared Runtime

Define gateway/target membership in `scripts/v2/agentcore/catalog.py`; provision through
`provision.py`, gated by `agentcore_enabled` (default false). `observability` maps to
`external-obs`; canonical and discovered `v2-` keys intentionally coexist. Direct domain
targets still coexist with the Aurora inventory reader under ADR-021.

### §2 Runtime customization substrate

Aurora agent/skill catalogs and account-scoped Agent Spaces drive resolver-selected personas,
composed skills, and tool allowlists. Preserve content-addressed artifacts, integrity checks,
immutable safeguards, traceable versions/hashes and fail-closed security revocation. Treat
custom skills and MCP output as untrusted; a cache TTL does not authorize revoked content.
Implementation clarification **2026-09-13**: custom candidates and their once-read Agent Space travel as one available/unavailable context. Both policy and catalog errors deny custom execution. Built-in routing is independent of custom caps and follows ADR-003's disclosed fallback posture. Instruction-only skills with no declarations and no durable `toolPolicyConfigured` restriction use the existing gateway read catalog as their baseline; an account cap can only narrow it. Declarations or retained/revoked restrictions keep empty intersections deny-all. An empty account cap means no account restriction, whereas an empty effective tool list denies all tools. The BFF encodes that list as `!awsops-deny-all!` for older runtimes; only the legacy unrestricted case omits it. Registry eligibility never proves live provisioning or tool availability.

### §3 Integration read substrate

Arbitrary BYO-MCP, mutating tools and AWS-resource execution remain frozen (ADR-005).
Curated external data uses ADR-007. Lambda schemas bound exposed tools; hosted vendor targets
instead need ADR-017's runtime fail-closed allowlist in both chat loops. Endpoint acknowledgement
alone is insufficient; managed egress does not inherit in-house connect-time IP pinning. Curated egress/ingress registration and toggles remain available to admins; `custom_mcp` is excluded. Registry enablement does not enable incident/write gates or AWS mutation.

### §4 Memory and conversation isolation

The provisioner configures a Memory resource with 365-day event expiry. Current explicit chat
persistence is Aurora. Runtime session IDs use the user sub and per-session entropy; account is
request payload context, not part of that session identifier. Provisioning Memory alone does not
establish account-partitioned Memory reads/writes. Verify the consumer before claiming that
integration. The accepted user/account isolation requirement remains: its enforcement is an
implementation obligation, not relaxed by the current gap. Exclude raw JWTs, cookies and credentials.

### §5 Code Interpreter sessions

Use per-request interpreter sessions with cleanup on completion/abort. Computational requests
use this managed path; it does not replace AWS API tools. Network mode and resource identifiers
come from the actual provisioner, not historical resource-name examples.

### §6 Configuration source of truth

SSM `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` is runtime configuration
authority. The BFF reads it at runtime instead of ECS `valueFrom` for these identifiers.

### §7 Aurora SQL boundary

Data API tools `aws_rds_mcp.execute_sql` and `inventory_read_mcp` use `awsops_sql_reader`,
not the Aurora master user. SELECT grants cover explicit-column `sql_reader` views with no
public base-table/column grants, write grants or elevated role membership. These owner-executed
views use `security_invoker = false`; do not grant direct base-table access as a workaround.
Keep credential/capability fields, including Kubernetes auth and worker task tokens, out of
projections. A new view/column is security-relevant; `SELECT *` can expose future schema additions.

Database grants are the boundary. Lexical guards, read-only transactions and
`search_path=sql_reader,pg_catalog` are defense in depth; role-settable options do not grant
privileges. Best-effort PUBLIC function revocation is not proof that no function can execute.
Use the dedicated Terraform reader secret synchronized by `make migrate`, with no master-secret
fallback. This is separate from the web BFF's `awsops_web` IAM-auth role.

## Consequences

Gateway separation, scoped runtime sessions and managed computation limit cross-domain and cross-user
exposure. Runtime customization adds catalog/revocation/integrity work; provisioned Memory is not
proof of an active persistence integration.
Remote MCP tool filtering and connection safety are different boundaries. Disabled historical code
is not evidence of an enabled capability.

## Six Pillars

Security: scoped tools, identities, secrets, SQL grants, and untrusted-content handling.
Operational Excellence and Reliability: reproducible provisioning, traceable runtime configuration,
and isolated memory/interpreter failures. Performance/Cost: focused tool surfaces and best-effort memory.

## Evidence

`agent/agent.py`, `agent/anthropic_loop.py`, `agent/lambda/{aws_rds_mcp,inventory_read_mcp}.py`,
`scripts/v2/agentcore/{catalog,provision}.py`, `terraform/v2/foundation/ai.tf`, and
`terraform/v2/foundation/migrations/01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql`.
