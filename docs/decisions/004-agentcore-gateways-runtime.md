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

- Define gateway/target membership in `scripts/v2/agentcore/catalog.py`; provision through `provision.py`.
  Use `agentcore_enabled` (default false). SSM
  `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` is runtime configuration authority;
  the BFF reads it rather than relying on ECS `valueFrom` for those identifiers.
- Keep routing and tool ownership aligned. `observability` maps to `external-obs`; canonical and
  discovered `v2-` keys intentionally coexist. Inspect the catalog for membership rather than copying
  gateway counts. Direct domain targets still coexist with the Aurora inventory reader (ADR-021).
- Aurora agent/skill catalogs and account-scoped Agent Spaces drive resolver-selected personas,
  composed skills, and tool allowlists. Content-addressed artifacts, integrity checks, immutable
  safeguards, and traceable versions/hashes remain required. Treat skills and MCP output as untrusted.
  Security revocation must fail closed; do not treat a cache TTL as authorization to keep revoked content.
- Arbitrary BYO-MCP, mutating tools, and AWS-resource execution remain frozen (ADR-005).
  Curated external reads/writes use ADR-007; custom personas do not relax those controls.
- Lambda MCP target schemas bound exposed tools. Hosted vendor MCP targets instead use ADR-017's
  runtime fail-closed allowlist in both chat loops. Endpoint acknowledgement alone is insufficient.
  Managed remote egress does not inherit the in-house connector's connect-time IP pinning.
- Shared AgentCore Memory uses user/account/session isolation and a configured event expiry of
  365 days. Application persistence remains Aurora; remote memory writes are best effort. Never store
  raw JWTs, cookies, or credentials. Memory availability must not block the basic conversation path.
- Code Interpreter uses per-request sessions with cleanup on completion/abort. Computational requests
  use this managed path; it is not a replacement for AWS API tools. Provisioned interpreter network
  mode and IDs come from actual provisioning code, not historical resource-name examples.

### Aurora SQL boundary

Data API tools `aws_rds_mcp.execute_sql` and `inventory_read_mcp` authenticate as
`awsops_sql_reader`, not the Aurora master user. Its SELECT grants cover only explicit-column views
in `sql_reader`, with no public base-table/column grants, write grants, or elevated role membership.
Views hide credentials/capabilities such as Kubernetes auth and worker task tokens. Adding a view or
column is security-relevant; `SELECT *` would reopen silent exposure when schemas grow.

Database grants are the boundary. Lexical SQL guards, read-only transactions, and
`search_path=sql_reader,pg_catalog` are defense in depth; role-settable options are not privileges.
Best-effort revocation of PUBLIC function execution is not a guarantee that no function can execute.
Use the dedicated Terraform secret synchronized by `make migrate` for Data API access. This is
separate from the web BFF's `awsops_web` IAM-auth role.

## Consequences

Gateway separation, scoped memory, and managed computation limit cross-domain and cross-user exposure.
Runtime customization adds catalog/revocation/integrity work; memory can lag local persistence.
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
