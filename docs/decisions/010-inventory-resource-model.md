# ADR-010: Inventory and Resource Model

## Status

Accepted **2026-06-22**, consolidating legacy ADRs 003 and 007.
Amended **2026-09-02** to permit explicitly accepted/disclosed hydrate-column risks, including
`iam_role.attached_policy_arns`. ADR-021's rollout note is **2026-08-31**.
Repository evidence checked **2026-09-13**. Amended **2026-10-29** to record the persistent
resource graph (§3) and partial progress on the unknown-attribute follow-up.

## Context

Inventory needs durable snapshots and honest coverage when accounts, permissions, or expensive
attribute hydration fail. Historical local JSON snapshots and live BFF Steampipe queries are not v2 paths.

## Decision

### §1 Resource inventory

- Persist inventory in Aurora `inventory_resources` and track sync state separately. Keep the UI type
  registry aligned with sync collectors, including composite identities such as ECS cluster/service.
- `steampipe_enabled` (default false) gates a warm Steampipe Fargate service plus a sync Lambda.
  The Lambda queries Steampipe and uses explicit SDK collectors for supported additions; it writes
  Aurora snapshots. This is batch ingestion, not the generic async Fargate job runner or live BFF SQL.
- ADR-021 governs quota controls, last-success preservation, freshness, and the phased Aurora-only
  target. Direct domain MCP tools and limited Aurora inventory tools still coexist in repository code.
### §2 SCP-blocked columns and query robustness

The v2 `spc_render.py` renderer does not set `ignore_error_codes`. A failing FDW table/base
query fails the resource type and preserves last-good rows. The named hydrate fallback below
and ADR-021's SDK partial-collection semantics are separate cases. Default to omitting risky
list attributes unless their risk is explicitly accepted and disclosed; do not reinstate the
superseded blanket ban from legacy ADR-003.

Recorded hydration-risk examples remain useful during permission diagnosis; they are not a
new instruction to remove accepted columns or expand IAM:

| Attribute / table | Current collection | Hydration API / recorded risk |
|---|---|---|
| `mfa_enabled` / `aws_iam_user` | Collected; no hydrate-free fallback | `iam:ListMFADevices` |
| `attached_policy_arns` / `aws_iam_user` | Not selected | Historical `iam:ListAttachedUserPolicies` risk; no current permission request |
| List-view `tags` / `aws_lambda_function` | Not selected | Historical `lambda:GetFunction` risk; absent data is not a current hydrate failure |
| `attached_policy_arns` / `aws_iam_role` | Collected with the accepted fallback below | `iam:ListAttachedRolePolicies` |

### Accepted hydrate fallback (2026-09-02)

`iam_role.attached_policy_arns` is retained for access-role investigation. If hydration fails, retry
once without that column. A successful fallback refreshes the base inventory with the column absent
and records `unknown_attribute_count` plus `inventory_sync_hydrate_fallback`. The S3 access-role
drill-down shows "not synced" for the absent column rather than a definitive absence of access.
The generic `iam_role` inventory page still needs a follow-up: `web/lib/inventory.ts` does not
project `unknown_attribute_count`, so do not claim all UI consumers disclose this gap. (Amended
2026-10-29: the aggregate collection ledger, `web/lib/inventory-collection.ts`, and graph reads,
`web/lib/graph-inventory-read.ts`, now disclose nonzero unknown attributes; the per-type page
follow-up still stands.) Final status
still follows the normal lifecycle: overlapping unreachable accounts can produce partial; later
DB failures can fail the run.

If the base query also fails, fail the whole type, skip pruning, and preserve last-good rows across
accounts. The aggregate Steampipe query is not account-isolated. The existing `iam_user.mfa_enabled`
hydrate predates this amendment and has no equivalent hydrate-free fallback; do not claim universal protection.

Steady permission blind spots and successful hydrate fallbacks disclose degraded freshness. A
transiently incomplete SDK resource is skipped rather than overwriting good content. These failure
classes are intentionally distinct; see ADR-021 for last-success/pruning semantics.

### §3 Persistent resource graph (amended 2026-10-29)

- Persist the resource graph in Aurora `topology_nodes`/`topology_edges` (Postgres-first). A
  dedicated graph store such as Neptune stays a deferred BASELINE option, not an adoption.
- Graph classes are `flow`, `infra` and `trace`. `topology_graph_state` records per-account,
  per-class collection status (`ok`/`empty`/`partial`/`unavailable`/`error`), retained evidence and
  source clocks; a missing row means unknown, not empty.
- Infra node identities are scoped `kind:@<account>:<region>:<id>`. Storage scope comes from the
  inventory and account selection, never from telemetry ownership claims; legacy unscoped ids are
  retained without inferring a region.
- Publication replaces a class only on verified source/account evidence; an unproven or over-capacity
  collection retains the last-good graph. Periodic rebuild is default off
  (`GRAPH_REBUILD_INTERVAL_MINS`).
- Readers serve stored vocabulary as-is and do not filter by an allowlist. Edges are cached
  configuration or telemetry context, not proof of live ownership. The SQL reader exposes only
  named-key projections of node metadata.
- An application-to-database dependency graph (a `dependency` class) is a proposal only — not
  accepted; it would need a future amendment of this section.

## Consequences

Batch snapshots stabilize request reads but can be stale or incomplete. Accepted hydration improves
useful evidence while preserving a base-inventory fallback. Fleet-wide rate budgets can cause hydrate
timeouts; denial requires permission review, whereas capacity tuning addresses a different cause.
Neither this decision nor a log remedy authorizes changing AWS permissions automatically.

## Six Pillars

Reliability: preserve last-good evidence and disclose missing attributes. Operational Excellence:
registry/collector alignment and explicit failure states. Security: read-only collection respecting
permission boundaries. Performance/Cost: bounded batch collection and reusable Aurora snapshots.

## Evidence

`web/lib/inventory-types.ts`, `web/lib/inventory.ts`, `scripts/v2/steampipe/sync_lambda.py`,
`terraform/v2/foundation/steampipe.tf` (public: `terraform/foundation/`), `agent/lambda/inventory_read_mcp.py`,
`web/lib/{graph-identity,graph-store,graph-state,inventory-collection}.ts`,
`docs/runbooks/graph-read-contract.md`, the `topology_graph_state` migration
(`01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql`), and ADR-021.
