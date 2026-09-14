import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationContext } from './migration-context.mjs';

const expected = {
  commit: 'a'.repeat(40), account: '123456789012', region: 'ap-northeast-2', project: 'awsops-fixture',
};
const context = {
  version: 1, ...expected, database: 'awsops',
  endpoint: 'awsops-fixture-aurora.cluster-example.ap-northeast-2.rds.amazonaws.com',
  secret_arn: 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-Abc123',
  sql_reader_secret_arn: 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-fixture/agent/sql-reader-Abc123',
};

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'awsops-migration-context-'));
  const path = join(root, 'context.json');
  const write = (value) => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); };
  write(context);
  try { fn(path, write); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('accepts source-bound non-secret connection metadata without Terraform', () => fixture((path) => {
  assert.deepEqual(readMigrationContext(path, expected), context);
}));

test('only explicit null disables the SQL-reader synchronization', () => fixture((path, write) => {
  write({ ...context, sql_reader_secret_arn: null });
  assert.equal(readMigrationContext(path, expected).sql_reader_secret_arn, null);
  const missing = { ...context };
  delete missing.sql_reader_secret_arn;
  write(missing);
  assert.throws(() => readMigrationContext(path, expected));
}));

test('rejects stale source, foreign targets, injected hosts and credential payloads', () => fixture((path, write) => {
  for (const changed of [
    { commit: 'b'.repeat(40) }, { account: '999999999999' },
    { region: 'us-east-1' }, { project: 'foreign' }, { database: 'postgres' },
    { endpoint: 'attacker.example.test' },
    { secret_arn: context.secret_arn.replace('123456789012', '999999999999') },
    { sql_reader_secret_arn: context.sql_reader_secret_arn.replace('awsops-fixture', 'foreign') },
    { password: 'must-not-be-in-metadata' },
  ]) {
    write({ ...context, ...changed });
    assert.throws(() => readMigrationContext(path, expected));
  }
}));

test('rejects public files and missing independent expectations', () => fixture((path) => {
  chmodSync(path, 0o644);
  assert.throws(() => readMigrationContext(path, expected));
  chmodSync(path, 0o600);
  assert.throws(() => readMigrationContext(path, { ...expected, account: '' }));
}));
