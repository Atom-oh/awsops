import { verifyUser } from '@/lib/auth';
import { currentAccountId } from '@/lib/account';
import { getAccount, validateAccountId } from '@/lib/accounts';
import { getEnabledCustomAgents } from '@/lib/catalog-source';
import { sectionByKey } from '@/lib/sections';

export const dynamic = 'force-dynamic';

/** Discover command names only. Actual chat invocation rechecks enablement and account scope. */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  if (process.env.HYBRID_ROUTING_ENABLED !== 'true') return Response.json({ enabled: false, agents: [] });
  const requested = new URL(request.url).searchParams.get('accountId');
  let accountId = currentAccountId();
  try {
    // The all-account chat selection uses the host, as the chat route does.
    if (requested && requested !== 'self' && requested !== '__all__' && requested !== accountId) {
      if (!validateAccountId(requested)) return Response.json({ error: 'invalid account' }, { status: 400 });
      const account = await getAccount(requested);
      if (!account?.enabled) return Response.json({ error: 'account unavailable' }, { status: 404 });
      accountId = requested;
    }
    const agents = (await getEnabledCustomAgents(accountId))
      .filter(a => !sectionByKey(a.name) && a.name !== 'auto' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(a.name))
      .map(a => ({ key: a.name, label: a.name, icon: '', active: true }));
    return Response.json({ enabled: true, agents });
  } catch {
    return Response.json({ error: 'agent catalog unavailable' }, { status: 503 });
  }
}
