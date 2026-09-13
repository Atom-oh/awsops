# AgentCore Tool Lambdas

Use root [CLAUDE.md](../../CLAUDE.md) and
[BASELINE.md](../../docs/decisions/BASELINE.md) for policy.
Live wiring is defined by `scripts/v2/agentcore/catalog.py`, `provision.py`, and
`terraform/v2/foundation/ai.tf`; a source file's presence does not make it live.

## Tool boundaries

- Use the provisioner's target schemas and credential configuration.
  Lambda targets use `GATEWAY_IAM_ROLE`; curated vendor MCP targets use their
  configured credential provider and fail-closed runtime tool allowlist.
- AWS-resource mutation/autonomy remains FROZEN. `create_targets.py` is a legacy
  provisioner; mutating legacy tools must not be wired into the live catalog.
  `core_helpers_mcp.py`, `reachability_read_mcp.py`, and `istio_read_mcp.py` are
  the current read-only replacements for their legacy counterparts.
- Cross-account AWS calls use `cross_account.py`. The host uses execution
  credentials directly; foreign targets use the configured role and ExternalId.
- Governed external-data writes follow ADR-007 separately from the AWS freeze.
  Preserve SSRF, credentials, DLP, human-gate, and feature-gate boundaries.
- Driver requirements are module-specific: `istio_read_mcp.py` uses the Kubernetes
  HTTP API; Aurora reader tools use RDS Data API. Do not impose a legacy
  Steampipe/pg8000 requirement on every Lambda.

## Aurora SQL reader

`aws_rds_mcp.py` and `inventory_read_mcp.py` use the dedicated `awsops_sql_reader`
credential and the `sql_reader` view schema. The role's restricted grants are the
primary boundary; `sql_readonly_guard.py` adds defense in depth.

- Server configuration chooses the reader secret and foundation cluster/database.
  Caller-supplied secret selection is ignored; missing config and foreign
  account/cluster targets fail closed. Do not fall back to the master secret.
- Keep base tables/columns in `public` inaccessible to the reader. Expose only
  reviewed explicit columns and named JSON-key projections through views.
  Raw tokens, credentials, and capability fields must remain excluded.
- Coordinate view changes with `inventory_read_mcp.PROJECTIONS` and
  `test_inventory_view_contract.py`; dropping fields can break valid reads.
- A lexical SQL gap needs an actual privilege/impact analysis. Do not assume the
  Aurora role protects ClickHouse or any other connector's query path.

Run affected `test_*.py` files from this directory. Schema grants live in
`terraform/v2/foundation/migrations/`; preserve merged migration checksums.
