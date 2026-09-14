// This image runs only the bundled migration code. No command/SQL comes from CI.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationContext } from '../migration-context.mjs';
import { hasNoTxnFlag } from '../migrate-core.mjs';

const filename = '[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_]+\\.sql';
function publishAudit(result, mode) {
  let redacted = 0;
  const emit = event => console.log(JSON.stringify({ type: 'awsops-migration-audit', mode, ...event }));
  for (const line of String(result.stdout || '').split('\n')) {
    const notice = /^\s*\[db\] (.*)$/.exec(line);
    if (notice) {
      const text = notice[1];
      const row = /^one-active de-dup: disabled report_schedules id=([1-9][0-9]{0,18}) user_sub=/.exec(text);
      const table = /^awsops_sql_reader: base table public\.([A-Za-z_][A-Za-z0-9_]{0,62}) not present/.exec(text);
      const remaining = /^awsops_sql_reader hardening: ([0-9]{1,6}) targeted function\(s\) STILL have PUBLIC EXECUTE/.exec(text);
      if (row) emit({ event: 'schedule_disabled', row_id: row[1],
        outcome: mode === 'preview' ? 'preview' : result.status === 0 ? 'committed' : 'unconfirmed' });
      else if (table) emit({ event: 'reader_view_skipped', table: table[1] });
      else if (remaining) emit({ event: 'public_execute_remaining', count: Number(remaining[1]) });
      else if (text === 'awsops_sql_reader hardening: PUBLIC EXECUTE revoked on all targeted functions') {
        emit({ event: 'public_execute_revoked' });
      } else if (text.startsWith('could not revoke PUBLIC EXECUTE on ')) {
        emit({ event: 'public_execute_revoke_skipped', details_redacted: true });
      } else if (text.startsWith('awsops_sql_reader/sql_reader absent') ||
                 text.startsWith('awsops_sql_reader is absent;')) {
        emit({ event: 'reader_absent' });
      } else redacted++;
    }
    const applied = new RegExp(`^\\s*✓ (${filename})$`).exec(line);
    if (applied && mode === 'apply') emit({ event: 'applied', migration: applied[1] });
    const pending = /^pending \(([0-9]{1,6})\):/.exec(line);
    if (pending) emit({ event: 'pending', count: Number(pending[1]) });
  }
  if (redacted) emit({ event: 'notice_redacted', count: redacted });
  if (result.error || result.status !== 0) {
    const error = String(result.stderr || '');
    const failed = new RegExp(`migration (${filename}) failed`).exec(error);
    let partial = null;
    if (failed) {
      try {
        partial = hasNoTxnFlag(readFileSync(
          `/app/terraform/v2/foundation/migrations/${failed[1]}`, 'utf8'));
      } catch { /* Missing metadata leaves partial state explicitly unknown. */ }
    }
    const code = /schema_migrations\.version is INTEGER/.test(error) ? 'bootstrap_required'
      : /checksum drift/.test(error) ? 'checksum_drift'
      : /certificate|CERT_|TLS/i.test(error) ? 'tls_failed'
      : /GetSecretValue|SecretsManager/.test(error) ? 'secret_read_failed'
      : /lock timeout|statement timeout/.test(error) ? 'database_timeout'
      : result.error ? 'process_timeout_or_start_failed'
      : failed ? 'sql_failed' : 'migration_failed';
    emit({ event: 'failed', code, migration: failed?.[1] ?? null,
      partial_state_possible: partial, details_redacted: true });
  }
}

let directory;
try {
  const commit = readFileSync('/app/.migration-source', 'utf8').trim();
  const mode = process.env.CI_MIGRATION_MODE;
  const nonce = process.env.CI_MIGRATION_NONCE;
  if (!/^[a-f0-9]{40}$/.test(commit) || commit !== process.env.CI_COMMIT_SHA
      || !['preview', 'apply'].includes(mode) || !/^[a-f0-9]{32}$/.test(nonce)
      || ['OFFLINE', 'STATUS', 'BOOTSTRAP', 'APP_VERSION'].some(k => process.env[k])) {
    throw new Error('context');
  }
  directory = mkdtempSync(join(tmpdir(), 'migration-'));
  const path = join(directory, 'context.json');
  writeFileSync(path, process.env.CI_MIGRATION_METADATA || '', { mode: 0o600 });
  readMigrationContext(path, {
    commit, account: process.env.CI_EXPECTED_ACCOUNT_ID,
    project: process.env.CI_EXPECTED_PROJECT, region: process.env.AWS_REGION,
  });
  const result = spawnSync(process.execPath, ['/app/scripts/v2/migrate.mjs'], {
    cwd: '/app', timeout: 900_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI_MIGRATION_CONTEXT: path, CI_MIGRATION_IMAGE: '1',
      DRY_RUN: mode === 'preview' ? '1' : '0' },
    encoding: 'utf8',
  });
  // Keep stable row IDs/progress and safe failure classes, never SQL, user_sub,
  // credentials, or arbitrary database/CLI messages. Unrecognized notices are disclosed.
  publishAudit(result, mode);
  if (result.error || result.status !== 0) throw new Error('execution');
  console.log(JSON.stringify({ type: 'awsops-migration', version: 1,
    commit, mode, nonce, status: 'succeeded' }));
} catch {
  console.error('origin migration failed; no successful receipt');
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
