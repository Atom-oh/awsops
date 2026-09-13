# Runbook: v1 to v2 Aurora History Backfill

Import a **copy** of selected historical v1 JSON stores. This does not change the application read
path, delete v1 data, or populate current `inventory_resources`. Repository commands checked
**2026-09-13**. Retirement import results belong to ADR-016's **2026-07-09** record, not this audit.

| Historical input | Aurora table |
|---|---|
| `inventory/[<account>/]<date>.json` | `inventory_snapshots` |
| `cost/[<account>/]<date>.json` | `cost_snapshots` |
| `alert-diagnosis/<month>/<id>.json` | `alert_diagnosis` |
| `event-scaling/<id>.json` | `event_scaling_plans` |

## 1. Prerequisites

Use a host with Aurora connectivity, this checkout, and `make deps` / `npm ci --prefix scripts/v2`.
The destination schema must already be migrated. Credential precedence in `backfill-v1.mjs` is:
`--dsn` or `BACKFILL_DSN`, then `AURORA_SECRET_ARN` plus `AURORA_ENDPOINT`, then foundation outputs.
Prefer its Secrets Manager/foundation-output flow; it is separate from the BFF's IAM DB auth.
Do not paste credential-bearing DSNs into shell history or logs.

## 2. Pull historical data

Use the retained authorized data copy where possible. v1 code was removed **2026-07-12** and AWS
cleanup has separately dated status (ADR-016); do not assume a running legacy instance or restart one
from this runbook. Extraction from an existing source is an operator-owned, out-of-band task;
this repository provides no current transfer procedure. The linked historical design is provenance.
Creating an archive through Run Command is an operator action,
not a claim that AWSops performs no remote command.

Archive only the approved stores, or protect a full archive as sensitive: excluded `config.json`
contains credentials even though the importer ignores it. Config/branding/ACLs, memory, AgentCore
statistics, and report schedules are not imported; ADR-016 records the accepted exclusions.
Extract a reviewed archive locally, preserving the expected store directories:

```bash
set -euo pipefail
: "${V1_ARCHIVE:?Set the path to the approved historical data archive}"
mkdir -p ./v1-data
tar -tzf "$V1_ARCHIVE"
# For an archive rooted at data/; review entries before extraction.
tar -xzf "$V1_ARCHIVE" -C ./v1-data --strip-components=1
```

## 3. Dry-run (no DB)

Set the account identity to the historical writer's value for a root-only layout, not merely today's
caller account. The default is `self`. In a multi-account layout the importer preserves account
subdirectories and assigns root combined snapshots to `aggregate`, preventing them from replacing a
real account's rows.

```bash
set -euo pipefail
: "${BACKFILL_ACCOUNT_ID:?Set the historical root-only writer account value}"
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data \
  --account-id "$BACKFILL_ACCOUNT_ID" --dry-run
```

Review would-write/skipped/error counts. A file error gives nonzero exit status; missing stores are
not proof that those histories never existed.

## 4. Run

Before a real inventory import, inspect destination account/day/type groups through a verified
Aurora connection. Replacement deletes **all resource types** for each imported account/day;
pre-existing v2 series on that same pair are not preserved. Avoid overlap unless a reviewed
preserve/restore plan covers those rows, and compare the same groups again after import.

```sql
SELECT account_id, (captured_at AT TIME ZONE 'UTC')::date AS day,
       array_agg(DISTINCT resource_type ORDER BY resource_type) AS existing_types,
       count(*) AS rows
FROM inventory_snapshots GROUP BY 1, 2 ORDER BY 1, 2;
```

After approving the dry-run and destination, use the same input/scope:

```bash
set -euo pipefail
: "${BACKFILL_ACCOUNT_ID:?Set the historical writer account value}"
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --account-id "$BACKFILL_ACCOUNT_ID"
# To restrict a separate approved run, append --only cost (or a comma-separated source list).
```

The runner masks connection credentials and reports per-source results. It uses per-file
transactions: a file error does not roll back successful files. For the Secrets Manager connection
path, set `PGSSLROOTCERT` to the reviewed RDS CA bundle for certificate verification.
Without that variable, this path uses `rejectUnauthorized: false`: it encrypts transport but
does not verify the server certificate.
`--dsn`/`BACKFILL_DSN` instead supplies its own connection/TLS settings; that branch bypasses the
runner's `PGSSLROOTCERT` helper. Verify the selected connection path before relying on its TLS mode.

## 5. Verify

Use an explicitly configured connection; an empty DSN must never fall back to a local database:

```bash
set -euo pipefail
: "${DSN:?Set a verified password-free Aurora DSN; use approved external credential handling}"
psql -X "$DSN" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'inventory' AS store, count(*) FROM inventory_snapshots
UNION ALL SELECT 'cost', count(*) FROM cost_snapshots
UNION ALL SELECT 'alert', count(*) FROM alert_diagnosis
UNION ALL SELECT 'scaling', count(*) FROM event_scaling_plans;
SQL
```

Idempotency is **equivalent final state**, not always `inserted=0`: inventory deletes/reinserts the
same account/day in one transaction; cost/scaling upsert; alerts skip conflicts. Compare scoped data,
including survival of pre-existing v2 series, not only aggregate counters. Mismatched account
identity can fork history into another account key.

## 6. Fidelity limits

Historical alerts lack source/fingerprint: `--alert-source` defaults to `unknown`, and fingerprint is
NULL, outside fingerprint-based dedup. Historical `event_scaling_plans` records are data only;
importing them does not authorize frozen scaling/remediation behavior. The importer neither performs
a read cutover nor deletes the source copy.
Legacy display-label resource types are not normalized. The v2 trend route excludes types that fail
`^[a-z0-9_]+$` and the combined `aggregate` account from its supported scopes. Those rows remain
archival; successful import does not establish dashboard visibility.

## 7. Tests

```bash
node --test scripts/v2/backfill-core.test.mjs
# Uses disposable PostgreSQL/Docker; inspect local prerequisites before running.
node scripts/v2/backfill-v1.itest.mjs
```

## Related

[ADR-001](../decisions/001-v2-foundation.md), [ADR-016](../decisions/016-v1-decommission.md),
`scripts/v2/{backfill-v1,backfill-core}.mjs`, and
[historical backfill design](../history/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md).
