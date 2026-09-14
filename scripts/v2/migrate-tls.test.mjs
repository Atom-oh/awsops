import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { migrationTls } from './migrate-tls.mjs';

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'awsops-migration-tls-'));
  for (const name of ['trusted', 'untrusted']) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(root, `${name}.key`), '-out', join(root, `${name}.pem`),
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-addext', 'basicConstraints=critical,CA:TRUE',
    ], { stdio: 'ignore' });
  }
});
after(() => rmSync(root, { recursive: true, force: true }));

async function connectTo(certName, servername) {
  const server = tls.createServer({
    key: readFileSync(join(root, `${certName}.key`)),
    cert: readFileSync(join(root, `${certName}.pem`)),
  }, (socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1', port: server.address().port,
        ...migrationTls(servername, join(root, 'trusted.pem')),
      });
      socket.once('secureConnect', () => { socket.destroy(); resolve(true); });
      socket.once('error', (error) => { socket.destroy(); reject(error); });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('accepts a trusted certificate for the actual database hostname', async () => {
  assert.equal(await connectTo('trusted', 'localhost'), true);
});

test('rejects an untrusted database certificate', async () => {
  await assert.rejects(connectTo('untrusted', 'localhost'), /self-signed|certificate/i);
});

test('rejects a trusted certificate for a different hostname', async () => {
  await assert.rejects(connectTo('trusted', 'wrong.example.test'), /hostname|altnames/i);
});

test('loads the committed RDS trust store without a network dependency', () => {
  const config = migrationTls('database.example.test');
  assert.equal(config.rejectUnauthorized, true);
  assert.equal(config.servername, 'database.example.test');
  assert.match(config.ca, /BEGIN CERTIFICATE/);
});

test('missing or malformed trust stores and invalid hostnames fail closed', () => {
  assert.throws(() => migrationTls('localhost', join(root, 'missing.pem')));
  writeFileSync(join(root, 'invalid.pem'), 'not a certificate');
  assert.throws(() => migrationTls('localhost', join(root, 'invalid.pem')));
  for (const host of ['', null, 'https://database.example.test', 'db\ninjected']) {
    assert.throws(() => migrationTls(host));
  }
});
