import { verifyUser } from '@/lib/auth';
import { listThreads } from '@/lib/chat-store';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    return json({ threads: await listThreads(user.sub) }, 200);
  } catch {
    return json({ threads: [] }, 200); // degrade, never 500 the drawer
  }
}
