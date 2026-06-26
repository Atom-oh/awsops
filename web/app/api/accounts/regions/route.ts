import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getAccount, validateAccountId } from '@/lib/accounts';
import { disableAccountRegion, listAccountRegions, upsertAccountRegion, validateRegion } from '@/lib/account-regions';
import { readJsonBounded } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

const err = (message: string, status: number) => Response.json({ status: 'error', message }, { status });

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) return err('unauthenticated', 401);
  try {
    return Response.json({ regions: await listAccountRegions() });
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
  const region = String(body?.region ?? '').trim();

  if (!validateAccountId(accountId)) return err('accountId must be self or 12 digits', 400);
  if (!validateRegion(region)) return err('region must be an AWS region id', 400);
  if (!(await getAccount(accountId))) return err('account not found', 404);

  try {
    await upsertAccountRegion(accountId, region);
    return Response.json({ ok: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function DELETE(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const url = new URL(request.url);
  const accountId = url.searchParams.get('accountId') || '';
  const region = url.searchParams.get('region') || '';

  if (!validateAccountId(accountId)) return err('accountId must be self or 12 digits', 400);
  if (!validateRegion(region)) return err('region must be an AWS region id', 400);
  if (!(await getAccount(accountId))) return err('account not found', 404);

  try {
    await disableAccountRegion(accountId, region);
    return Response.json({ ok: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}
