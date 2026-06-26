import { getPool } from '@/lib/db';

export interface AccountRegion {
  accountId: string;
  region: string;
  enabled: boolean;
}

const REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

export function validateRegion(region: string): boolean {
  return REGION_RE.test(region);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRow(r: any): AccountRegion {
  return {
    accountId: r.account_id,
    region: r.region,
    enabled: r.enabled,
  };
}

export async function listAccountRegions(accountId?: string): Promise<AccountRegion[]> {
  const args: string[] = [];
  let where = 'WHERE enabled = true';
  if (accountId) {
    args.push(accountId);
    where += ' AND account_id = $1';
  }
  const { rows } = await getPool().query(
    `SELECT account_id, region, enabled
       FROM account_regions
      ${where}
      ORDER BY account_id ASC, region ASC`,
    args,
  );
  return rows.map(mapRow);
}

export async function upsertAccountRegion(accountId: string, region: string): Promise<void> {
  await getPool().query(
    `INSERT INTO account_regions (account_id, region, enabled, updated_at)
     VALUES ($1, $2, true, now())
     ON CONFLICT (account_id, region) DO UPDATE SET enabled = true, updated_at = now()`,
    [accountId, region],
  );
}

export async function disableAccountRegion(accountId: string, region: string): Promise<void> {
  await getPool().query(
    'UPDATE account_regions SET enabled = false, updated_at = now() WHERE account_id = $1 AND region = $2',
    [accountId, region],
  );
}
