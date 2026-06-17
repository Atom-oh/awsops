// Admin-gated registered-accounts CRUD. POST verifies the target by assuming its role and
// asserting GetCallerIdentity.Account === the submitted id (anti-spoof) BEFORE inserting.
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPool } from '@/lib/db';
import { listAccounts, getAccount, validateAccountId, ensureHostRow } from '@/lib/accounts';
import { readJsonBounded } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const err = (message: string, status: number) => Response.json({ status: 'error', message }, { status });

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) return err('unauthenticated', 401);
  try {
    await ensureHostRow(); // seed the host row (HOST_ACCOUNT_ID) so the selector + __all__ fan-out always include host
    return Response.json({ accounts: await listAccounts() });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const body = (await readJsonBounded(request).catch(() => null)) as Record<string, unknown> | null;
  const accountId = String(body?.accountId ?? '').trim();
  const alias = String(body?.alias ?? '').trim();
  const region = String(body?.region ?? '').trim() || REGION;
  const externalId = String(body?.externalId ?? '').trim();
  // Hard-pinned to match the host task-role IAM (Resource scoped to .../AWSopsReadOnlyRole).
  // A custom roleName would fail-closed on assume, so we do not honor body.roleName.
  const roleName = 'AWSopsReadOnlyRole';

  if (!validateAccountId(accountId)) return err('accountId must be 12 digits', 400);
  if (!alias) return err('alias is required', 400);
  if (!externalId) return err('externalId is required (confused-deputy guard)', 400);

  // Test-assume the target role, then confirm the assumed identity IS the submitted account.
  try {
    const sts = new STSClient({ region: REGION });
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
      RoleSessionName: 'awsops-verify',
      ExternalId: externalId,
      DurationSeconds: 900,
    }));
    const c = assumed.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      return err('assume returned no credentials', 400);
    }
    const asTarget = new STSClient({
      region: REGION,
      credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
    });
    const ident = await asTarget.send(new GetCallerIdentityCommand({}));
    if (ident.Account !== accountId) {
      return err(`verification failed: assumed account ${ident.Account} != ${accountId}`, 400);
    }
  } catch (e) {
    return err(`assume/verify failed: ${e instanceof Error ? e.message : String(e)}`, 400);
  }

  // Verified → insert. If the INSERT fails, surface 500 (never report verified without a row).
  try {
    await getPool().query(
      `INSERT INTO accounts (account_id, alias, region, is_host, role_name, external_id, enabled, status, last_verified_at)
       VALUES ($1, $2, $3, false, $4, $5, true, 'verified', now())
       ON CONFLICT (account_id) DO UPDATE SET
         alias = EXCLUDED.alias, region = EXCLUDED.region, role_name = EXCLUDED.role_name,
         external_id = EXCLUDED.external_id, status = 'verified', last_verified_at = now()`,
      [accountId, alias, region, roleName, externalId],
    );
  } catch (e) {
    return err(`insert failed: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
  return Response.json({ ok: true, status: 'verified' });
}

export async function DELETE(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const accountId = new URL(request.url).searchParams.get('accountId') || '';
  if (!validateAccountId(accountId)) return err('accountId must be 12 digits', 400);
  const acct = await getAccount(accountId);
  if (acct?.isHost) return err('cannot remove the host account', 400);
  try {
    await getPool().query('DELETE FROM accounts WHERE account_id = $1 AND is_host = false', [accountId]);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
  return Response.json({ ok: true });
}
