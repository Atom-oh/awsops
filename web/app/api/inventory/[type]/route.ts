import { verifyUser } from '@/lib/auth';
import { readResources } from '@/lib/inventory';
import { INVENTORY_TYPES } from '@/lib/inventory-types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  if (!(params.type in INVENTORY_TYPES)) {
    return Response.json({ status: 'error', message: 'unknown type' }, { status: 404 });
  }
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const offset = Number(url.searchParams.get('offset')) || 0;
  const regionsParam = url.searchParams.get('regions');
  const regions = regionsParam && regionsParam !== '__all__' ? regionsParam.split(',').filter(Boolean) : '__all__';
  const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
  try {
    return Response.json(await readResources(params.type, { limit, offset, regions, includeGlobal }));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
