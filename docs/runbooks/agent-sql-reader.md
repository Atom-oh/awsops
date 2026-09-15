# Runbook: Agent SQL Reader Recovery

Use this when agent `execute_sql` or `inventory-read` fails Data API authentication while ordinary
RDS describe/list tools still work. Checked against repository code **2026-09-13**; no live recovery
was performed by this documentation audit.

The security boundary is the dedicated `awsops_sql_reader` role and explicit-column `sql_reader`
views. Data API uses its Terraform-owned Secrets Manager secret, synchronized by
`scripts/v2/migrate.mjs:syncSqlReaderPassword`. This is separate from the web BFF's IAM-authenticated
`awsops_web` role. Never repair a reader failure by granting the master secret or base-table access.

## Enable order

For an approved AgentCore enablement, the controller creates the reader secret through a reviewed
saved plan, then the operator runs migrations/password sync before provisioning gateways:

```bash
terraform -chdir=terraform/v2/foundation apply tfplan
make migrate
make agentcore
```

`make agentcore` does not migrate or synchronize passwords. A false `agentcore_enabled` gate has no
reader secret to synchronize. `make migrate-status` is offline and cannot prove what this DB applied.

## Recovery

| Symptom | Verify | Action |
|---|---|---|
| Data API authentication fails; role exists | Compare migration/sync logs without printing credentials | Run `make migrate`; password sync runs on every non-dry invocation |
| `role not present yet — skipping password sync` | Check the actual DB migration ledger | Apply pending role migration, or use a new repair migration if already recorded |
| Foundation cluster/unset-env error | Check Lambda's configured cluster/database/reader secret | Correct configuration; do not accept caller-supplied credentials or another cluster |
| Elevated role attribute failure | Inspect role attributes | Reviewed repair required; do not bypass the guard |

### Password mismatch

After an approved secret regeneration, restoration, or manual password correction:

```bash
make migrate
```

Expected log: `sql-reader: password synced from Secrets Manager`. No automatic rotation-convergence
hook exists; the gap until the next migration run is a recorded tradeoff, not permission to add an
ALTER ROLE-capable automation path.

### Role absent

```bash
# Connects to the actual DB ledger without applying migrations or syncing passwords.
env -u OFFLINE DRY_RUN=1 make migrate
```

If `01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql` is pending, `make migrate` creates the role.
If already recorded but the role is absent, rerunning does not recreate it. Add a **new reviewed ULID
repair migration**; never edit a merged migration/checksum or erase ledger entries.

The repair must recreate the role, current explicit-column views, and grants. Follow the original
role migration's guarded DO-block pattern; PostgreSQL has no `CREATE ROLE IF NOT EXISTS`.
Aurora's master user cannot clear elevated SUPERUSER/REPLICATION/BYPASSRLS attributes by restating
them in ALTER ROLE. If an approved repair must drop an existing bad role, review its dependencies
and use `DROP OWNED BY awsops_sql_reader` immediately before `DROP ROLE`; it is unnecessary if absent.
Do not turn that dependency cleanup into a general-purpose command against another role.

Use **current** view definitions from all later migrations, not just the original role migration:
`inventory_sync_runs` needs last-success and unknown-attribute fields; notification and graph views
also gained reviewed projections. A repair that restores old columns can authenticate successfully
while silently breaking consumers. The elevated-attribute migration and every password sync fail loud
if the role still has elevated attributes.

## Verify

Invoke `execute_sql` with `SELECT 1` through the configured agent, then check inventory freshness.
This tool's SQL scope is the host foundation Aurora database; v2's broader multi-account support does
not authorize this SQL tool to use arbitrary cross-account clusters, databases, or caller secrets.

Expected privilege boundaries when testing as `awsops_sql_reader`:

- Base-table reads such as `public.inventory_resources` are denied.
- Writes to `sql_reader` views are denied; `worker_jobs.task_token` is not exposed.
- CloudFront origins keep `DomainName` but exclude secret `CustomHeaders[].HeaderValue` and
  unapproved cache behaviors. Topology projections exclude whole-row copies.

## Dated PostgreSQL verification

The previous runbook records actual execution on **2026-08-03**, using `postgres:17-alpine`, baseline
schema and the then-current **37** ULID migrations. RDS prerequisite roles were supplied for vanilla
PostgreSQL. Base-table reads/view writes were denied and the sensitive projections above were checked.
This historical result is not a test of today's complete migration set. Text-matching contract tests
cannot prove SQL parses; execute affected migrations against disposable PostgreSQL when changing them.

### Trace queue projection

`01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql` introduces graph evidence;
`01M2FV44NER7VC3CTX2ZMT9FZG_topology_inventory_evidence.sql` adds bounded inventory source clocks and provenance;
`01M2GRW64VTMC9AC8M7T9MZKQ4_graph_attempt_disclosure.sql` owns the current collection-state
projection with explicit not-attempted and count-reconciliation reasons;
`01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql` supersedes the earlier topology-node projection.
After migration, inspect trace queue views: `claimedAccountId`/`claimedRegion` come only from parsed
destination ARN qualifiers, including retained rows. Malformed/non-ARN destinations have null claims,
without reporter fallback. `identityProvenance` is `telemetry_claim`; real-account fields, `infra_ref`,
and whole-row copies stay absent. Only the view receives SELECT.

The writer records flow, infra and trace collection state. Node `captured_at` is
materialization time; use `sql_reader.topology_graph_state` for source clocks, retained
evidence and bounded source reasons. Trace sources also expose query windows. Missing
state, qualifiers or timestamps never establish complete or empty coverage.

`scripts/v2/workers/test_graph_collection.py` covers reapplication and grants on disposable PostgreSQL.
AI tool behavior also requires deploying the updated inventory Lambda; see
[source-sync rollout](source-sync-observability.md).

## Related

- [ADR-004](../decisions/004-agentcore-gateways-runtime.md): Aurora SQL boundary.
- `scripts/v2/migrate.mjs`, `terraform/v2/foundation/ai.tf`, and foundation ULID migrations.
- `agent/lambda/{aws_rds_mcp,inventory_read_mcp,test_inventory_view_contract}.py`.
