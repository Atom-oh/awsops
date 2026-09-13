# Aurora and Persistent State

Policy: [BASELINE](../decisions/BASELINE.md). Aurora stores application state,
job/report records, configuration, and materialized inventory/topology.

## Infrastructure and credentials

[data.tf](../../terraform/v2/foundation/data.tf) defines Aurora PostgreSQL
Serverless v2 in private subnets, encrypted storage/managed master secret,
IAM DB authentication, and the RDS Data API endpoint. Engine/scaling defaults
come from `variables.tf`; read deployed values from the target environment.
The database SG admits application tasks, gated Steampipe tasks, and optional
VPC migration access. Keep SG descriptions unchanged.

| Consumer | Current authentication |
| --- | --- |
| Web `web/lib/db.ts` | IAM DB token per new pool connection as `awsops_web` |
| Workers `scripts/v2/workers/db.py` | IAM DB token per connection as `awsops_worker` |
| Steampipe boot configuration | IAM DB access as `steampipe_reader` |
| Agent Aurora tools | Dedicated `awsops_sql_reader` secret through RDS Data API |
| Migration runner and inventory sync writer | Configured Aurora master secret from Secrets Manager |

Do not describe the BFF or shared worker client as holding an injected master
password. The current web/worker PostgreSQL clients encrypt connections but
skip server-certificate verification; they are not CA-verified clients.
The agent reader has no direct grants on base tables in `public`: explicit-column
views in `sql_reader` project only approved fields/JSON keys. Preserve those grants
and [reader contracts](../../agent/lambda/CLAUDE.md).

## Schema lifecycle

[The frozen schema](../../terraform/v2/foundation/data/schema.sql) plus
[ULID migrations](../../terraform/v2/foundation/migrations/) define the database.
Use `make migrate` from the repository root; the runner validates filenames,
checksums, and the migration ledger under an advisory lock. Preserve merged SQL,
including `-- since:` headers. `make migrate-status` is offline;
`DRY_RUN=1 make migrate` compares against the live ledger without applying SQL.

`make migrate` also synchronizes the SQL reader credential and must precede
`make agentcore`. See [the SQL reader runbook](../runbooks/agent-sql-reader.md).
Migrations affecting a running Lambda must precede deployment of code using the
new columns. In particular, inventory sync writes `inventory_sync_runs.run_token`.
For an enabled environment, stage images without rolling, migrate against current
outputs, then create/apply the saved plan. For first enablement, establish Aurora
with sync disabled, migrate, publish the image, then enable via the final plan.
`make deploy` rolls web, not the inventory Lambda.

## Inventory and freshness

[Batch sync](../../scripts/v2/steampipe/sync_lambda.py) loads Aurora through the
gated Steampipe backend and scoped SDK collectors. Powerpipe compliance also uses
that backend in a worker. Browser/chat live Steampipe SQL remains hard-disabled;
`steampipe_enabled` does not reopen it. The limited Aurora ops reader and direct
domain MCP API targets coexist; an Aurora-only tool fleet is not implemented.

Durable `last_success_at`/`last_success_row_count` preserve genuine zero-row
success across later failed or partial attempts. Failed account coverage retains
last-good rows. Attribute blind spots are disclosed separately through
`unknown_attribute_count`. The [inventory reader](../../agent/lambda/inventory_read_mcp.py)
uses durable success and oldest current captures to distinguish healthy, degraded,
stale, and unavailable data. Fresh partial rows must not hide retained stale rows.

## Operational limits

Current Terraform sets seven-day backups, deletion protection off, and skips a
final snapshot; assess these explicitly before destructive operations. Engine
version drift is ignored on both cluster and instance. A major upgrade needs a
snapshot and a reviewed plan that actually performs the version change; simply
editing the variable while retaining `ignore_changes` does not schedule it.
