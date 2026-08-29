// GET /api/datasources/[id]/cards — pre-built dashboard cards for one datasource (the card
// dashboard on /integrations/datasources/[id]). Authenticated; single-account
// (WHERE account_id='self'); DB read only (no egress). Also returns the instance kind so the
// client can normalize live query results without an extra fetch.
import { verifyUser } from '@/lib/auth';
import { getDashboardCards } from '@/lib/dashboard-cards';
import { getDatasource } from '@/lib/datasources';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  const id = Number(params?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'valid id required' }, 400);
  try {
    const [cards, ds] = await Promise.all([getDashboardCards(id), getDatasource(id)]);
    return json({ ...cards, kind: ds?.kind ?? '' }, 200);
  } catch (e) {
    console.error('[dashboard-cards] read failed:', e); // detail to server logs only
    return json({ error: 'failed to load dashboard cards' }, 500); // generic to client (no internal leak)
  }
}
