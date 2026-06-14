import { verifyUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  return Response.json({ sub: user.sub, email: user.email, groups: user.groups ?? [] });
}
