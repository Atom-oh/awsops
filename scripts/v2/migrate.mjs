#!/usr/bin/env node
// AWSops v2 DB migration runner — collision-free, fail-loud, advisory-locked.
//   make migrate            apply pending migrations (terraform/v2/foundation/migrations/*.sql)
//   DRY_RUN=1 make migrate  list pending + SQL, no connect/exec
//   BOOTSTRAP=1 make migrate one-time: ALTER schema_migrations.version→TEXT + ADD checksum (controller-confirmed)
// Creds from `terraform output -raw aurora_secret_arn` → Secrets Manager (mirrors scripts/13-deploy-aurora.sh).
// pg is resolved from the repo-root node_modules (also a web/ dep). Requires PostgreSQL DDL transactionality.
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { parseMigrationFile, computePending, sha256, findDuplicateIds, hasNoTxnFlag } from './migrate-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // scripts/v2 → repo root
const MIG_DIR = join(ROOT, 'terraform', 'v2', 'foundation', 'migrations');
const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const TF = 'terraform/v2/foundation';
const LOCK_KEY = 4729411; // arbitrary constant — serializes concurrent `make migrate`
const DRY = process.env.DRY_RUN === '1';
const BOOTSTRAP = process.env.BOOTSTRAP === '1';

const tf = (out) => execSync(`terraform -chdir=${TF} output -raw ${out}`, { cwd: ROOT, encoding: 'utf8' }).trim();
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

// 1. Load migration files + fail-loud duplicate-id precheck (before connecting).
if (!existsSync(MIG_DIR)) die(`migrations dir not found: ${MIG_DIR}`);
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const dups = findDuplicateIds(files);
if (dups.length) die(`duplicate migration id(s): ${dups.join(', ')} — ids must be unique (ULID)`);
const migrations = files
  .map((f) => { const p = parseMigrationFile(f); return p ? { ...p, file: f, sql: readFileSync(join(MIG_DIR, f), 'utf8') } : null; })
  .filter(Boolean);
const badNames = files.filter((f) => !parseMigrationFile(f));
if (badNames.length) die(`malformed migration filename(s) (need <ULID>_<name>.sql): ${badNames.join(', ')}`);

// No migration files (e.g. empty migrations/ today) → nothing to do; skip the DB connection entirely
// so `make deploy` (which depends on migrate) stays cheap until the first ULID migration is authored.
if (migrations.length === 0) { console.log('migrate: no migration files — nothing to do'); process.exit(0); }

// 2. Creds (skip the network in pure dry-run with no DB).
function loadCreds() {
  const secretArn = tf('aurora_secret_arn');
  const endpoint = tf('aurora_endpoint');
  const secret = JSON.parse(execSync(
    `aws secretsmanager get-secret-value --region ${REGION} --secret-id ${secretArn} --query SecretString --output text`,
    { cwd: ROOT, encoding: 'utf8' },
  ));
  return { host: endpoint, user: secret.username, password: secret.password, database: 'awsops', port: 5432, ssl: { rejectUnauthorized: false } };
}

async function main() {
  const client = new pg.Client({ ...loadCreds(), statement_timeout: 300_000, lock_timeout: 30_000 });
  await client.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;

    // Column-type detect → bootstrap gate.
    const { rows: cols } = await client.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='version'`,
    );
    const versionType = cols[0]?.data_type ?? 'text';
    const hasChecksum = (await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='checksum'`,
    )).rowCount > 0;

    const { rows: appliedRows } = await client.query(
      hasChecksum ? 'SELECT version, checksum FROM schema_migrations' : 'SELECT version, NULL AS checksum FROM schema_migrations',
    );
    const applied = new Map(appliedRows.map((r) => [String(r.version), r.checksum ?? null]));
    const pending = computePending(migrations.map((m) => m.id), [...applied.keys()]);

    if (versionType === 'integer' && pending.length > 0) {
      if (!BOOTSTRAP) die('schema_migrations.version is INTEGER but ULID migrations are pending.\n  Bootstrap required (controller-confirmed, run during a coordinated quiet window):\n    BOOTSTRAP=1 make migrate');
      console.log('[bootstrap] ALTER version→TEXT + ADD checksum + baseline marker');
      if (!DRY) {
        // All three are transactional DDL/DML in PostgreSQL — run them as ONE atomic unit so a
        // crash/lock-timeout mid-bootstrap can't leave the column TEXT but the baseline marker
        // missing (the integer→text gate at line 75 would then never re-insert it). Rolls back to
        // the clean INTEGER state on any failure → fully re-runnable.
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE schema_migrations ALTER COLUMN version TYPE TEXT USING version::text');
          await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
          await client.query(`INSERT INTO schema_migrations(version, applied_at, description) VALUES ('baseline', now(), 'schema.sql baseline; future migrations are ULID files') ON CONFLICT (version) DO NOTHING`);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          die(`bootstrap failed (rolled back to INTEGER): ${e instanceof Error ? e.message : e}`);
        }
      }
    } else if (!hasChecksum && !DRY && pending.length > 0) {
      await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    }

    // Drift check: an already-applied migration's file must not have changed.
    for (const m of migrations) {
      const rec = applied.get(m.id);
      if (rec !== undefined && rec !== null && rec !== sha256(m.sql)) {
        die(`checksum drift: applied migration ${m.id} (${m.file}) was edited after apply — migrations are immutable`);
      }
    }

    if (pending.length === 0) { console.log('✅ up to date — no pending migrations'); return; }
    console.log(`pending (${pending.length}): ${pending.join(', ')}`);

    for (const id of pending) {
      const m = migrations.find((x) => x.id === id);
      const checksum = sha256(m.sql);
      if (DRY) { console.log(`\n--- ${m.file} ---\n${m.sql}`); continue; }
      const noTxn = hasNoTxnFlag(m.sql);
      try {
        if (noTxn) {
          await client.query(m.sql); // autocommit (e.g. CREATE INDEX CONCURRENTLY)
          await client.query('INSERT INTO schema_migrations(version, applied_at, description, checksum) VALUES ($1, now(), $2, $3)', [m.id, m.name, checksum]);
        } else {
          await client.query('BEGIN');
          await client.query(m.sql); // DDL — simple query, no params
          // plain INSERT (no ON CONFLICT) → duplicate id = PK violation = fail-loud
          await client.query('INSERT INTO schema_migrations(version, applied_at, description, checksum) VALUES ($1, now(), $2, $3)', [m.id, m.name, checksum]);
          await client.query('COMMIT');
        }
        console.log(`  ✓ ${m.file}`);
      } catch (e) {
        if (!noTxn) await client.query('ROLLBACK').catch(() => {});
        die(`migration ${m.file} failed (rolled back): ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`\n✅ applied ${pending.length} migration(s)`);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}

// Pure dry-run (list files + SQL) without a DB connection when explicitly offline.
if (DRY && process.env.OFFLINE === '1') {
  console.log(`migrations dir: ${MIG_DIR}\nfiles (${migrations.length}): ${migrations.map((m) => m.file).join(', ')}`);
  for (const m of migrations) console.log(`\n--- ${m.file} ---\n${m.sql}`);
  process.exit(0);
}
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
