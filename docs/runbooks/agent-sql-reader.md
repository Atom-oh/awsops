# Runbook: `awsops_sql_reader` (agent `execute_sql` / `inventory-read`)

The agent's read-only SQL boundary is a **DB role**, not a lexical guard: migration
`01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql` creates `awsops_sql_reader`
(`NOSUPERUSER … NOBYPASSRLS`, `default_transaction_read_only = on`, SELECT only on the
`sql_reader` schema's views). The RDS Data API needs a Secrets Manager secret (there is no
IAM DB auth on that path), so this one role has a password — Terraform generates it and
`syncSqlReaderPassword` in `scripts/v2/migrate.mjs` converges the DB role onto the secret.

## Enable order — `make migrate` is required, and it is easy to miss

```
terraform -chdir=terraform/v2/foundation apply tfplan   # creates the reader secret
make migrate                                            # creates the ROLE + syncs its password
make agentcore                                          # provisions the gateways/targets
```

`make agentcore` does **not** run migrations and does **not** sync the password. The published
enable flow is `apply → make agentcore`, so skipping `make migrate` is the expected mistake, and
the failure does not look like a missing migration:

| Symptom | Cause |
|---|---|
| `execute_sql` and `inventory-read` fail with a Data API **auth** error | role absent, or its password ≠ the secret |
| `migrate` logs `sql-reader: role not present yet — skipping password sync` | ran before the role-creating migration |

Both tools fail; the other rds-mcp tools (`describe_*`, `list_*`) keep working because they use
the execution role, not the reader secret. That asymmetry is the tell.

## Recovery

The two symptoms have **different** fixes — an earlier version of this runbook offered
`make migrate` for both, which cannot fix the second one (PR #197 review MAJOR).

### Password mismatch → `make migrate`

`syncSqlReaderPassword` runs on **every** invocation, independently of whether any migration is
pending, so this is genuinely idempotent:

```
make migrate            # ALTER ROLE awsops_sql_reader WITH PASSWORD <secret>
```

Do this after **anything that changes the secret**:

- Terraform regenerates/rotates `agent_sql_reader_secret_arn`
- the secret is restored from a backup
- the role's password was changed by hand

### Role absent → depends on whether the migration already applied

`migrate.mjs` runs only **pending** migrations and enforces checksum immutability on applied ones, so
re-running it will NOT recreate a role whose migration is already recorded — the sync step just logs
`role not present yet — skipping password sync` again, which reads like a no-op rather than the
failure it is.

```
DRY_RUN=1 make migrate  # is 01KYVY9J…_agent_sql_reader_role still pending, against the LIVE DB?
```

Not `make migrate-status` (PR #197 review MAJOR) — that target is explicitly offline (`Makefile`: "no DB
connect"; it only compares the app version to migration files on disk). It cannot tell you whether a
migration was actually applied to THIS environment's database, which is exactly the question this
step needs answered. `DRY_RUN=1 make migrate` connects and diffs against the live
`schema_migrations` ledger without executing anything.

- **Still pending** (fresh environment, or migrations never ran): `make migrate` applies it and
  creates the role. Done.
- **Already applied** but the role is gone (dropped by hand, restored from a snapshot predating it):
  the recorded checksum makes that file un-runnable. Add a **new repair migration** that recreates
  the role, its `sql_reader` views and the grants — copy the DDL from
  `01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql`, which is written to be re-runnable — the
  role is created inside a `DO` block guarded by `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname
  = 'awsops_sql_reader')` (Postgres has no `CREATE ROLE IF NOT EXISTS`), every attribute is then
  stated explicitly by `ALTER ROLE`, and each view is `DROP VIEW IF EXISTS`-ed before `CREATE` — then
  `make migrate`. Do not edit the original file: `migrate.mjs` will refuse on checksum drift, and
  editing it would also change history for every other environment.

There is deliberately **no** automatic converge-on-rotation hook. The window between a
Terraform-side password change and the next `make migrate` is a known gap, accepted rather than
engineered away — closing it would need a rotation-triggered Lambda with `ALTER ROLE` rights on
Aurora, which is a larger change than the failure it prevents (two read-only tools erroring until
one idempotent command runs).

## Verify

```
make migrate            # expect: "sql-reader: password synced from Secrets Manager"
```

Then invoke `execute_sql` (e.g. `SELECT 1`) through the agent. A `400` naming the foundation
cluster or an unset env var is a configuration error, not an auth error — see
`agent/lambda/aws_rds_mcp.py`. Only the host's own foundation Aurora cluster is reachable;
cross-account and caller-supplied `secret_arn`/`database` are fail-closed.

## Related

- `terraform/v2/foundation/migrations/01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql` — role + views
- `scripts/v2/migrate.mjs` (`syncSqlReaderPassword`) — the sync
- `docs/decisions/004-agentcore-gateways-runtime.md` §7 — the `execute_sql` security model
