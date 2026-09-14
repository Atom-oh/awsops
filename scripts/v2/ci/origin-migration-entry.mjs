// This image runs only the bundled migration code. No command/SQL comes from CI.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationContext } from '../migration-context.mjs';

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
  // Do not forward SQL notices, raw CLI failures, or credentials to CloudWatch.
  if (result.error || result.status !== 0) throw new Error('execution');
  console.log(JSON.stringify({ type: 'awsops-migration', version: 1,
    commit, mode, nonce, status: 'succeeded' }));
} catch {
  console.error('origin migration failed; no successful receipt');
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
