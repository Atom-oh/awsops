import { Pool } from 'pg';

let pool: Pool | null = null;

// Single shared pg Pool for all API routes (Aurora PostgreSQL; RDS-managed master secret
// is surfaced as AURORA_USER/AURORA_PASSWORD env by the ECS task. ssl rejectUnauthorized:false
// mirrors the worker's pg8000 CERT_NONE — no RDS CA bundling in this env).
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.AURORA_ENDPOINT,
      port: 5432,
      database: process.env.AURORA_DATABASE || 'awsops',
      user: process.env.AURORA_USER,
      password: process.env.AURORA_PASSWORD,
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}
