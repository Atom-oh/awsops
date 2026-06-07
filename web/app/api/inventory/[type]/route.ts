import { verifyUser } from '@/lib/auth';
import { readResources } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const offset = Number(url.searchParams.get('offset')) || 0;
  try {
    return Response.json(await readResources(params.type, { limit, offset }));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
