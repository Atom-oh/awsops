// Execute the real entry point in a subprocess. Only /app's immutable source
// marker and the child-process boundary are replaced; private metadata IO and
// readMigrationContext run unchanged. Never execute migrations or contact AWS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const commit = 'a'.repeat(40);
const nonce = 'b'.repeat(32);
const account = '123456789012';
const project = 'awsops-v2';
const region = 'ap-northeast-2';
const metadata = {
  version: 1, commit, account, project, region, database: 'awsops',
  endpoint: `${project}-aurora.cluster-example.${region}.rds.amazonaws.com`,
  secret_arn: `arn:aws:secretsmanager:${region}:${account}:secret:rds!cluster-example-AbCd12`,
  sql_reader_secret_arn: `arn:aws:secretsmanager:${region}:${account}:secret:ops/${project}/agent/sql-reader-EfGh34`,
};
const sentinel = 'SYNTHETIC_PASSWORD_DO_NOT_LOG';

const hook = `
import fs from 'node:fs';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalRead = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  return path === '/app/.migration-source'
    ? process.env.TEST_IMAGE_COMMIT
    : originalRead.call(this, path, ...args);
};
child.spawnSync = function(binary, args, options) {
  const path = options.env.CI_MIGRATION_CONTEXT;
  fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({
    binary, args, cwd: options.cwd, timeout: options.timeout, maxBuffer: options.maxBuffer,
    encoding: options.encoding, contextPath: path,
    contextMode: fs.statSync(path).mode & 0o777,
    contextOwner: fs.statSync(path).uid,
    context: JSON.parse(originalRead(path, 'utf8')),
    dryRun: options.env.DRY_RUN, image: options.env.CI_MIGRATION_IMAGE,
    commit: options.env.CI_COMMIT_SHA,
  }), { mode: 0o600 });
  return {
    status: process.env.TEST_CHILD_STATUS === 'null' ? null : Number(process.env.TEST_CHILD_STATUS),
    error: process.env.TEST_CHILD_ERROR ? new Error('SYNTHETIC_PASSWORD_DO_NOT_LOG') : undefined,
    stdout: 'SYNTHETIC_PASSWORD_DO_NOT_LOG', stderr: 'SYNTHETIC_PASSWORD_DO_NOT_LOG',
  };
};
syncBuiltinESMExports();
`;

function execute(changes = {}, context = metadata) {
  const directory = mkdtempSync(join(tmpdir(), 'origin-entry-test-'));
  const capture = join(directory, 'capture.json');
  const preload = join(directory, 'preload.mjs');
  writeFileSync(preload, hook, { mode: 0o600 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CI_MIGRATION_') || key.startsWith('TEST_')
        || ['OFFLINE', 'STATUS', 'BOOTSTRAP', 'APP_VERSION', 'NODE_OPTIONS'].includes(key)) delete env[key];
  }
  Object.assign(env, {
    TMPDIR: directory, CI_COMMIT_SHA: commit, CI_EXPECTED_ACCOUNT_ID: account,
    CI_EXPECTED_PROJECT: project, AWS_REGION: region,
    CI_MIGRATION_MODE: 'apply', CI_MIGRATION_NONCE: nonce,
    CI_MIGRATION_METADATA: JSON.stringify(context),
    TEST_IMAGE_COMMIT: commit, TEST_CAPTURE: capture, TEST_CHILD_STATUS: '0',
  }, changes);
  try {
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(preload).href, join(here, 'origin-migration-entry.mjs'),
    ], { cwd: root, env, timeout: 10_000, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const child = existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null;
    if (child) {
      assert.equal(existsSync(child.contextPath), false, 'Private metadata must be deleted after child exit');
      assert.equal(existsSync(dirname(child.contextPath)), false, 'Private temporary directory must be removed');
    }
    assert.ok(!result.stdout.includes(sentinel), 'SQL/CLI output must never become a receipt');
    assert.ok(!result.stderr.includes(sentinel), 'Raw failures must not reach logs');
    return { ...result, child };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const mode of ['preview', 'apply']) {
  test(`${mode}: uses bundled code, private metadata and exact bounded receipt`, () => {
    // Ambient DRY_RUN must not turn apply into a successful preview (or vice versa).
    const result = execute({ CI_MIGRATION_MODE: mode, DRY_RUN: mode === 'apply' ? '1' : '0' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      type: 'awsops-migration', version: 1, commit, mode, nonce, status: 'succeeded',
    });
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.deepEqual(result.child.context, metadata);
    assert.equal(result.child.contextMode, 0o600);
    assert.equal(result.child.contextOwner, process.geteuid());
    assert.deepEqual(result.child.args, ['/app/scripts/v2/migrate.mjs']);
    assert.equal(result.child.binary, process.execPath);
    assert.equal(result.child.cwd, '/app');
    assert.equal(result.child.timeout, 900_000);
    assert.equal(result.child.maxBuffer, 8 * 1024 * 1024);
    assert.equal(result.child.encoding, 'utf8');
    assert.equal(result.child.dryRun, mode === 'preview' ? '1' : '0');
    assert.equal(result.child.image, '1');
    assert.equal(result.child.commit, commit);
  });
}

test('disabled reader is preserved as null', () => {
  const result = execute({}, { ...metadata, sql_reader_secret_arn: null });
  assert.equal(result.status, 0);
  assert.equal(result.child.context.sql_reader_secret_arn, null);
});

for (const [name, changes] of [
  ['different bundled source', { TEST_IMAGE_COMMIT: 'c'.repeat(40) }],
  ['invalid bundled source', { TEST_IMAGE_COMMIT: 'main' }],
  ['uppercase source', { TEST_IMAGE_COMMIT: 'A'.repeat(40), CI_COMMIT_SHA: 'A'.repeat(40) }],
  ['different requested source', { CI_COMMIT_SHA: 'c'.repeat(40) }],
  ['unknown mode', { CI_MIGRATION_MODE: 'status' }],
  ['missing mode', { CI_MIGRATION_MODE: '' }],
  ['invalid nonce', { CI_MIGRATION_NONCE: 'b'.repeat(31) }],
  ['uppercase nonce', { CI_MIGRATION_NONCE: 'B'.repeat(32) }],
  ['malformed metadata JSON', { CI_MIGRATION_METADATA: '{' }],
  ['empty metadata', { CI_MIGRATION_METADATA: '' }],
  ...['OFFLINE', 'STATUS', 'BOOTSTRAP', 'APP_VERSION'].map(key => [key + ' bypass', { [key]: '1' }]),
]) {
  test(`rejects ${name} before spawning migrations`, () => {
    const result = execute(changes);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'origin migration failed; no successful receipt');
    assert.equal(result.child, null);
  });
}

for (const [key, value] of [
  ['commit', 'c'.repeat(40)], ['account', '999999999999'], ['region', 'us-east-1'],
  ['project', 'other'], ['version', true], ['database', 'other'],
  ['endpoint', metadata.endpoint + '.attacker.example'],
  ['secret_arn', metadata.secret_arn.replace(account, '999999999999')],
  ['secret_arn', metadata.secret_arn.replace('example-AbCd12', '*')],
  ['sql_reader_secret_arn', metadata.sql_reader_secret_arn.replace(project, 'other')],
]) {
  test(`rejects invalid ${key} in private metadata`, () => {
    const result = execute({}, { ...metadata, [key]: value });
    assert.equal(result.status, 1);
    assert.equal(result.child, null);
    assert.equal(result.stdout, '');
  });
}

test('rejects extra secret values rather than passing them to a task', () => {
  const result = execute({}, { ...metadata, password: sentinel });
  assert.equal(result.status, 1);
  assert.equal(result.child, null);
  assert.equal(result.stdout, '');
});

for (const [name, changes] of [
  ['nonzero exit', { TEST_CHILD_STATUS: '1' }],
  ['termination', { TEST_CHILD_STATUS: 'null' }],
  ['timeout/start error', { TEST_CHILD_ERROR: '1' }],
]) {
  test(`${name}: fails without a receipt and removes private context`, () => {
    const result = execute(changes);
    assert.equal(result.status, 1);
    assert.notEqual(result.child, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'origin migration failed; no successful receipt');
  });
}

test('Docker packages the runner import closure, SQL, metadata, dependencies and trusted CA', () => {
  const docker = readFileSync(join(here, 'Dockerfile.origin-migration'), 'utf8');
  assert.match(docker, /^FROM node:22-alpine$/m);
  assert.match(docker, /^RUN apk add --no-cache aws-cli$/m);
  assert.match(docker, /npm ci --prefix scripts\/v2 --omit=dev --ignore-scripts/);
  assert.match(docker, /^USER node$/m);
  assert.match(docker, /^CMD \["node", "scripts\/v2\/ci\/origin-migration-entry\.mjs"\]$/m);
  assert.doesNotMatch(docker, /^ENTRYPOINT/m);
  const copied = new Set();
  for (const line of docker.split('\n').filter(line => line.startsWith('COPY '))) {
    const tokens = line.trim().split(/\s+/).slice(1);
    for (const source of tokens.slice(0, -1)) {
      assert.ok(existsSync(join(root, source)), `Missing build context source: ${source}`);
      copied.add(source);
    }
  }
  for (const path of [
    'scripts/v2/package.json', 'scripts/v2/package-lock.json',
    'terraform/v2/foundation/migrations', 'scripts/v2/eks/rds-ca-bundle.pem',
    'web/package.json',
  ]) assert.ok(copied.has(path), `Docker must package ${path}`);
  const visited = new Set();
  function checkImports(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const relative = path.slice(root.length + 1);
    assert.ok(copied.has(relative), `Missing runtime import in Docker COPY: ${relative}`);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      checkImports(resolve(dirname(path), match[1]));
    }
  }
  checkImports(join(here, 'origin-migration-entry.mjs'));
  checkImports(join(root, 'scripts/v2/migrate.mjs'));
  const pkg = JSON.parse(readFileSync(join(root, 'scripts/v2/package.json'), 'utf8'));
  assert.ok(pkg.dependencies.pg, 'node-pg must survive npm ci --omit=dev');
  assert.match(docker, /ARG SOURCE_COMMIT/);
  assert.match(docker, /test "\$\{#SOURCE_COMMIT\}" = 40/);
  assert.match(docker, /chmod 444 \.migration-source/);
});
