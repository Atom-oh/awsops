import { verifyUser } from '@/lib/auth';
import { getServiceCostDetail } from '@/lib/aws';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const service = new URL(request.url).searchParams.get('service');
  if (!service || service.length > 100) {
    return Response.json({ status: 'error', message: 'service query param required (≤100 chars)' }, { status: 400 });
  }
  try {
    return Response.json(await getServiceCostDetail(service));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
