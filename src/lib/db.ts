/**
 * ADR-030 Phase 1: Aurora pg Pool for application state.
 *
 * Distinct from `steampipe.ts` — Steampipe queries AWS APIs in real time
 * (FDW, in-memory results), while Aurora persists application state that
 * must survive container restarts: inventory snapshots, cost snapshots,
 * conversation memory, agentcore stats, alert diagnosis records,
 * event-scaling plans, and report schedules.
 *
 * The pool is lazily initialized so existing single-host deployments
 * without Aurora provisioned don't pay the connection cost at startup.
 */
import { Pool, type PoolConfig } from 'pg';
import { readFileSync, existsSync } from 'fs';
import type { ConnectionOptions } from 'tls';

let pool: Pool | null = null;
let initPromise: Promise<Pool> | null = null;

interface AuroraCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/**
 * Resolves Aurora connection details.
 *
 * Phase 1 supports two paths, evaluated in order:
 *   1. `AURORA_DATABASE_URL` env var (DSN, e.g. postgres://user:pw@host:5432/awsops?sslmode=require)
 *   2. Discrete env vars: AURORA_HOST, AURORA_PORT, AURORA_DB, AURORA_USER, AURORA_PASSWORD
 *
 * Phase 1.5 will add Secrets Manager fetch via AURORA_SECRET_ARN. For now,
 * the deploy script (`13-deploy-aurora.sh`) reads the secret and injects
 * the DSN into the Next.js process env.
 */
function resolveCredentials(): AuroraCredentials | null {
  const dsn = process.env.AURORA_DATABASE_URL;
  if (dsn) {
    try {
      const u = new URL(dsn);
      return {
        host: u.hostname,
        port: u.port ? Number(u.port) : 5432,
        database: u.pathname.replace(/^\//, '') || 'awsops',
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        ssl: (u.searchParams.get('sslmode') ?? 'require') !== 'disable',
      };
    } catch {
      // Fall through to discrete env vars
    }
  }

  const host = process.env.AURORA_HOST;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.AURORA_PORT ?? '5432'),
    database: process.env.AURORA_DB ?? 'awsops',
    user: process.env.AURORA_USER ?? 'awsops_admin',
    password: process.env.AURORA_PASSWORD ?? '',
    ssl: (process.env.AURORA_SSLMODE ?? 'require') !== 'disable',
  };
}

/**
 * Build TLS options for the Aurora connection.
 *
 * Default is `rejectUnauthorized: true` — RDS is always TLS, and the in-VPC
 * SG-only ingress doesn't excuse skipping cert verification. Use one of:
 *   - AURORA_SSL_CA      — PEM string (full chain)
 *   - AURORA_SSL_CA_FILE — path to a PEM file (e.g. RDS global bundle)
 *   - AURORA_SSL_INSECURE=1 — local-dev escape hatch (logs a warning)
 *
 * Without an explicit CA, Node falls back to the system trust store; the
 * RDS root chains to Amazon Trust Services which is in the default bundle.
 * Operators are still encouraged to pin the RDS global bundle via
 * AURORA_SSL_CA_FILE for defense in depth.
 */
function buildSsl(creds: AuroraCredentials): ConnectionOptions | false {
  if (!creds.ssl) return false;

  if (process.env.AURORA_SSL_INSECURE === '1') {
    console.warn('[db] AURORA_SSL_INSECURE=1 — TLS cert verification disabled. ' +
      'Do NOT use in production.');
    return { rejectUnauthorized: false };
  }

  const caInline = process.env.AURORA_SSL_CA?.trim();
  if (caInline) return { rejectUnauthorized: true, ca: caInline };

  const caFile = process.env.AURORA_SSL_CA_FILE?.trim();
  if (caFile) {
    if (!existsSync(caFile)) {
      throw new Error(`AURORA_SSL_CA_FILE points to a missing file: ${caFile}`);
    }
    return { rejectUnauthorized: true, ca: readFileSync(caFile, 'utf-8') };
  }

  // Default: verify against the system trust store. RDS global bundle chains
  // through Amazon Trust Services, which is in the default Node bundle.
  return { rejectUnauthorized: true };
}

function buildPoolConfig(creds: AuroraCredentials): PoolConfig {
  return {
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.user,
    password: creds.password,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
    ssl: buildSsl(creds),
    application_name: 'awsops-dashboard',
  };
}

export function isAuroraEnabled(): boolean {
  return resolveCredentials() !== null;
}

export async function getDb(): Promise<Pool> {
  if (pool) return pool;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const creds = resolveCredentials();
    if (!creds) {
      throw new Error(
        'Aurora not configured. Set AURORA_DATABASE_URL or AURORA_HOST/USER/PASSWORD/DB. ' +
          'See ADR-030 and scripts/13-deploy-aurora.sh.',
      );
    }
    const p = new Pool(buildPoolConfig(creds));
    p.on('error', (err) => {
      console.error('[db] Aurora pool error:', err.message);
    });
    pool = p;
    return p;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Runs SELECT 1 and reads schema_migrations.version. Returns the highest
 * applied migration version, or throws if the schema is unreachable.
 */
export async function checkDbHealth(): Promise<{ ok: true; schemaVersion: number }> {
  const db = await getDb();
  const r = await db.query<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations',
  );
  return { ok: true, schemaVersion: r.rows[0]?.version ?? 0 };
}

/**
 * Closes the pool — call from a graceful shutdown hook only. The Next.js
 * server reuses the pool across requests, so this should not run per-request.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
