# DB migrations (`make migrate`)

Collision-free, fail-loud DB migrations applied by `scripts/v2/migrate.mjs` (run via `make migrate`,
and automatically before `make deploy`). Decision record: `docs/reviews/2026-06-11-migration-mechanism-consensus.md`.

## Why this exists
The legacy single `schema.sql` used sequential integer versions (`v8`, `v9`, …) + `INSERT … ON CONFLICT
DO NOTHING`. Concurrent branches kept **preempting the same integer** (manual renumber every time) and the
`ON CONFLICT` **silently masked** duplicates. This directory replaces that for all NEW migrations.

## Authoring a migration
1. Generate a **ULID** id (sortable, collision-proof across concurrent branches):
   ```
   node -e "import('ulid').then(m=>console.log(m.ulid()))"   # or any ULID generator
   ```
2. Create `terraform/v2/foundation/migrations/<ULID>_<snake_name>.sql`, e.g.
   `01J9Z8XK3P7QF2VN6T0BC4D5EH_opencost_config.sql`.
3. Put **only DDL/data** in the file. **Do NOT** write `schema_migrations` — the runner stamps it
   (version + sha256 checksum) in the same transaction. Do NOT use `ON CONFLICT DO NOTHING` on the ledger.
4. Non-transactional statements (`CREATE INDEX CONCURRENTLY`, some `ALTER TYPE … ADD VALUE`) — put
   `-- migrate:no-transaction` as the first line; the runner runs that file in autocommit.

## Rules
- **Never edit an applied migration** — the runner stores a sha256 (LF-normalized) and aborts on drift.
- One migration = one logical change. Additive-forward preferred; destructive ops need a deliberate review.
- IDs must be unique ULIDs — the runner aborts before connecting if two files share an id.

## Apply
- `make migrate` — apply pending (advisory-locked, pending-only, fail-loud). `make deploy` runs it first.
- `DRY_RUN=1 make migrate` — list pending + SQL, no exec. `DRY_RUN=1 OFFLINE=1` — no DB connection.
- `BOOTSTRAP=1 make migrate` — **one-time, controller-confirmed**: migrates the legacy `schema_migrations.version`
  INTEGER→TEXT + adds the `checksum` column + a `baseline` marker. Run during a coordinated quiet window
  (concurrent sessions may still INSERT integer rows). Legacy integer rows (v1..vN) are preserved as applied;
  the baseline `schema.sql` stays as the one-time bootstrap of those tables.
