// POST /api/insights/refresh — admin-only; enqueue an AI Insights regeneration. Fail-closed when the
// feature flag is off; dedups against a recently-enqueued/running insight job (avoids duplicate Bedrock jobs).
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { enqueueInsightRefresh } from '@/lib/insights';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);
  try {
    const result = await enqueueInsightRefresh();
    if (result === 'disabled') return json({ error: 'ai insights disabled' }, 503);
    return json({ status: result }, 202);  // queued | deduped
  } catch (e) {
    console.error('[insights] refresh enqueue failed:', e);
    return json({ error: 'failed to enqueue refresh' }, 500);
  }
}
