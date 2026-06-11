# AWSops v2 — `make migrate` runner (collision-free migrations) Implementation Plan

> Decision record: `docs/reviews/2026-06-11-migration-mechanism-consensus.md` (5/5 unanimous Option C).
> **Additive + non-destructive**: keeps `schema.sql` as the baseline; adds `migrations/` + runner + Makefile wiring. **Live `ALTER version TYPE TEXT` + first run are a deferred controller step.** Branch `feat/v2-migrations` (off published feat/v2).

## Goal
Make DB version bumps collision-free forever: sortable-id (ULID/UTC-µs) migration files + a `make migrate` runner that applies pending-only, in one transaction per file, fail-loud on duplicate/checksum drift, and runs before `make deploy`.

## Conventions
- Pure logic (id parse/sort, pending-diff, checksum, dup-validate) in `scripts/v2/migrate-core.mjs` — unit-tested by web vitest via relative import. pg/CLI side in `scripts/v2/migrate.mjs`.
- New migration SQL files **never** touch `schema_migrations` (the runner stamps). Legacy `schema.sql` baseline blocks are left as-is (idempotent).
- Runner creds: `terraform output -raw aurora_secret_arn` → Secrets Manager → user/pass; endpoint from `terraform output`; `PGSSLMODE=require`; password via env only.

---

### Task 1: `scripts/v2/migrate-core.mjs` — pure runner core + tests

**Files:**
- Create: `scripts/v2/migrate-core.mjs`
- Test: `web/lib/migrate-core.test.ts`

- [ ] **Step 1 (RED):** `web/lib/migrate-core.test.ts` imports `../../../scripts/v2/migrate-core.mjs`. Test: `parseMigrationFile('01J0_x.sql')→{id:'01J0',name:'x'}` (reject no-id); `sortIds` (lexical, legacy ints sort before ULID); `computePending(fileIds, appliedIds)` = fileIds − appliedIds sorted (finds ALL gaps, not just >max); `sha256(text)` stable; `findDuplicateIds(files)` flags dup id (fail-loud precheck); `hasNoTxnFlag('-- migrate:no-transaction\n…')`→true.
- [ ] **Step 2 (GREEN):** `scripts/v2/migrate-core.mjs` exports those pure fns (no pg, no fs side-effects beyond pure string ops — fs reads passed in).
- [ ] **Step 3 (commit):** `cd web && npx vitest run lib/migrate-core.test.ts` green. Commit both.

### Task 2: `scripts/v2/migrate.mjs` — pg/CLI runner

**Files:**
- Create: `scripts/v2/migrate.mjs`

- [ ] **Step 1:** runner: read `migrations/*.sql`; **load-time `findDuplicateIds` → abort** before connecting. Creds via `aurora_secret_arn` (mirror `scripts/13-deploy-aurora.sh:load_pg_env`), `PGSSLMODE=require`. Connect (Node `pg`).
- [ ] **Step 2:** `pg_advisory_lock(<const>)`. Detect `schema_migrations.version` type: if **INTEGER and string-id migrations are pending** → abort with "bootstrap required: `make migrate BOOTSTRAP=1` (controller-confirmed live ALTER)". `BOOTSTRAP=1` → `ALTER TABLE schema_migrations ALTER COLUMN version TYPE TEXT USING version::text` (only if currently INTEGER) + insert a `baseline` marker, then continue.
- [ ] **Step 3:** `computePending` (recorded = `SELECT version FROM schema_migrations`). For each pending file in order: if `-- migrate:no-transaction` → run autocommit; else **`BEGIN; <ddl>; INSERT INTO schema_migrations(version, applied_at, description) VALUES ($id, now(), $name); COMMIT;`** (plain INSERT — duplicate id → PK violation → fail-loud). Store checksum (extend ledger with a `checksum` column via the baseline migration, nullable for legacy). On applied-file checksum mismatch → abort. `statement_timeout`/`lock_timeout` set per session. `DRY_RUN=1` → print pending + SQL, no exec. `pg_advisory_unlock` in finally.
- [ ] **Step 4 (commit):** `node --check scripts/v2/migrate.mjs` (syntax) + manual dry-run note. Commit.

### Task 3: `migrations/` dir + README convention

**Files:**
- Create: `terraform/v2/foundation/migrations/README.md`
- Create: `terraform/v2/foundation/migrations/.gitkeep`

- [ ] **Step 1:** README: id scheme (ULID, `node -e "console.log(require('ulid').ulid())"` or a date+rand helper), `<id>_<snake_name>.sql`, no `schema_migrations` writes in files, `-- migrate:no-transaction` flag usage, "never edit an applied migration (checksum)". `.gitkeep` so the dir ships empty.
- [ ] **Step 2 (commit):** commit.

### Task 4: Makefile — `migrate` target + `deploy: migrate`

**Files:**
- Modify: `Makefile`

- [ ] **Step 1:** add `.PHONY: migrate` + `migrate: ## Apply pending DB migrations (idempotent, fail-loud, advisory-locked)` → `@node scripts/v2/migrate.mjs`. Wire `deploy: migrate` (deploy depends on migrate) so `make deploy` applies pending migrations before rolling ECS. Keep `make deploy`'s existing recipe.
- [ ] **Step 2 (commit):** `make -n deploy` shows migrate runs first. Commit.

### Task 5 (CONTROLLER, deferred): live transition + first migration

**Files:** (none committed here — runtime ops)

- [ ] **Step 1:** coordinate with the concurrent session (shared `schema_migrations`). When agreed: `make migrate BOOTSTRAP=1` on live (advisory-locked `ALTER version TYPE TEXT` + baseline marker; preserves v1..vN integer rows).
- [ ] **Step 2:** first real migration = OpenCost `opencost_config` (and any future) authored as `migrations/<ulid>_opencost_config.sql`; OpenCost PR #32 drops its `schema.sql` v10 block in favor of this. `make migrate` applies it (live max+1 reconcile is now automatic — no integer to pick).
- [ ] **Step 3:** verify `schema_migrations` shows legacy ints + the new string id; `make deploy` runs migrate→deploy cleanly.

## Done criteria (this PR)
- `migrate-core` unit tests green; `node --check scripts/v2/migrate.mjs` passes; `make -n deploy` runs `migrate` first.
- Additive only — `schema.sql` baseline + concurrent integer blocks untouched; no live ALTER performed in this PR.
- Decision record committed; P4 gate clean; PR into `feat/v2-architecture-design` (no auto-merge).
