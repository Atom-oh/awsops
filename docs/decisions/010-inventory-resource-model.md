# ADR-010: Inventory and Resource Model

## Status

Accepted **2026-06-22**, consolidating legacy ADRs 003 and 007.
Amended **2026-09-02** to permit explicitly accepted/disclosed hydrate-column risks, including
`iam_role.attached_policy_arns`. ADR-021's rollout note is **2026-08-31**.
Repository evidence checked **2026-09-13**.

## Context

Inventory needs durable snapshots and honest coverage when accounts, permissions, or expensive
attribute hydration fail. Historical local JSON snapshots and live BFF Steampipe queries are not v2 paths.

## Decision

- Persist inventory in Aurora `inventory_resources` and track sync state separately. Keep the UI type
  registry aligned with sync collectors, including composite identities such as ECS cluster/service.
- `steampipe_enabled` (default false) gates a warm Steampipe Fargate service plus a sync Lambda.
  The Lambda queries Steampipe and uses explicit SDK collectors for supported additions; it writes
  Aurora snapshots. This is batch ingestion, not the generic async Fargate job runner or live BFF SQL.
- ADR-021 governs quota controls, last-success preservation, freshness, and the phased Aurora-only
  target. Direct domain MCP tools and limited Aurora inventory tools still coexist in repository code.
- Avoid list-wide failure from denied/expensive hydrate columns. `ignore_error_codes` is not a promise
  that every query succeeds. Default to omitting risky list attributes unless their risk is explicitly
  accepted and disclosed. Do not reinstate the superseded blanket ban from legacy ADR-003.

### Accepted hydrate fallback (2026-09-02)

`iam_role.attached_policy_arns` is retained for access-role investigation. If hydration fails, retry
once without that column. A successful fallback refreshes the base inventory with the column absent
and records `unknown_attribute_count` plus `inventory_sync_hydrate_fallback`. Consumers show
"not synced" rather than a definitive absence of access. Final status still follows the normal
lifecycle: overlapping unreachable accounts can produce partial; later DB failures can fail the run.

If the base query also fails, fail the whole type, skip pruning, and preserve last-good rows across
accounts. The aggregate Steampipe query is not account-isolated. The existing `iam_user.mfa_enabled`
hydrate predates this amendment and has no equivalent hydrate-free fallback; do not claim universal protection.

Steady permission blind spots and successful hydrate fallbacks disclose degraded freshness. A
transiently incomplete SDK resource is skipped rather than overwriting good content. These failure
classes are intentionally distinct; see ADR-021 for last-success/pruning semantics.

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
`terraform/v2/foundation/steampipe.tf`, `agent/lambda/inventory_read_mcp.py`, and ADR-021.
