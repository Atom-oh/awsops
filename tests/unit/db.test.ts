// Unit tests for src/lib/db.ts — env-var resolution + isAuroraEnabled.
// ADR-030 Phase 1 retroactive coverage. Tests are isolated from a real Aurora
// instance: they only exercise the credential-resolution side of the API
// (isAuroraEnabled), not the pg Pool creation path (getDb / checkDbHealth).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAuroraEnabled } from '@/lib/db';

const AURORA_ENV_KEYS = [
  'AURORA_DATABASE_URL',
  'AURORA_HOST',
  'AURORA_PORT',
  'AURORA_DB',
  'AURORA_USER',
  'AURORA_PASSWORD',
  'AURORA_SSLMODE',
  'AURORA_SSL_CA',
  'AURORA_SSL_CA_FILE',
  'AURORA_SSL_INSECURE',
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of AURORA_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function clearAuroraEnv(): void {
  for (const k of AURORA_ENV_KEYS) delete process.env[k];
}

describe('db.ts — isAuroraEnabled / credential resolution', () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = snapshotEnv();
    clearAuroraEnv();
  });

  afterEach(() => {
    clearAuroraEnv();
    for (const [k, v] of Object.entries(original)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it('returns false when no Aurora env vars are set', () => {
    expect(isAuroraEnabled()).toBe(false);
  });

  it('returns true when AURORA_DATABASE_URL is set', () => {
    process.env.AURORA_DATABASE_URL =
      'postgres://u:p@aurora.example.com:5432/awsops?sslmode=require';
    expect(isAuroraEnabled()).toBe(true);
  });

  it('returns true when AURORA_HOST is set without a DSN', () => {
    process.env.AURORA_HOST = 'aurora.example.com';
    process.env.AURORA_USER = 'awsops_admin';
    process.env.AURORA_PASSWORD = 'pw';
    expect(isAuroraEnabled()).toBe(true);
  });

  it('returns false when only AURORA_USER/PASSWORD are set (host required)', () => {
    process.env.AURORA_USER = 'awsops_admin';
    process.env.AURORA_PASSWORD = 'pw';
    expect(isAuroraEnabled()).toBe(false);
  });

  it('falls back to discrete env vars when AURORA_DATABASE_URL is malformed', () => {
    process.env.AURORA_DATABASE_URL = 'this-is-not-a-valid-url-at-all';
    process.env.AURORA_HOST = 'aurora.example.com';
    expect(isAuroraEnabled()).toBe(true);
  });

  it('accepts an AURORA_DATABASE_URL with no port (libpq default 5432 assumed)', () => {
    process.env.AURORA_DATABASE_URL =
      'postgres://u:p@aurora.example.com/awsops';
    expect(isAuroraEnabled()).toBe(true);
  });

  it('accepts an AURORA_DATABASE_URL with sslmode=disable', () => {
    process.env.AURORA_DATABASE_URL =
      'postgres://u:p@aurora.example.com:5432/awsops?sslmode=disable';
    expect(isAuroraEnabled()).toBe(true);
  });

  it('treats AURORA_HOST as enabled regardless of AURORA_SSLMODE value', () => {
    process.env.AURORA_HOST = 'aurora.example.com';
    process.env.AURORA_SSLMODE = 'disable';
    expect(isAuroraEnabled()).toBe(true);
  });
});
