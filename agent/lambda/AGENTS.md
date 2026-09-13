<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 6002b4e4f78c · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> Reviewer context distilled from this module’s CLAUDE.md; shared by Kiro, Codex, and Agy.

# Tool Lambda Review

Use root [CLAUDE.md](../../CLAUDE.md) and
[BASELINE.md](../../docs/decisions/BASELINE.md) for policy.

- Live catalog/wiring: `scripts/v2/agentcore/catalog.py`, `provision.py`, and
  `terraform/v2/foundation/ai.tf`. The legacy `create_targets.py` and mutating
  tools stay dark. AWS mutation/autonomy is FROZEN; governed external-data
  writes have separate ADR-007 controls.
- Lambda targets use `GATEWAY_IAM_ROLE`; vendor MCP targets use their configured
  provider and runtime tool allowlist. Follow the provisioner, not a universal
  credential/driver rule.
- Use `cross_account.py`; host calls use execution credentials directly.
- Aurora SQL tools use server-selected `awsops_sql_reader` credentials and the
  foundation cluster/database. Missing config or foreign targets fail closed;
  caller secret selection must not elevate privileges.
- Preserve view-only grants in `sql_reader`, explicit columns, and named JSON
  projections. Keep base tables/columns in `public` inaccessible and exclude
  credentials/capability tokens. Align views with `inventory_read_mcp.PROJECTIONS`
  and `test_inventory_view_contract.py`.
- The DB grants are the primary SQL boundary; lexical guards add defense in
  depth. Analyze actual impact rather than a denylist omission alone. Other
  connectors do not inherit the Aurora role boundary.

Run affected `test_*.py` files from `agent/lambda/`. Review schema grants in
`terraform/v2/foundation/migrations/` and preserve merged checksums.
