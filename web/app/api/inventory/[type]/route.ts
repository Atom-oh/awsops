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
  // `.get()` returns null only when the param is absent — distinct from an explicit `regions=`
  // (empty string), which must resolve to an empty array, not silently fall back to unfiltered.
  const regionsParam = url.searchParams.get('regions');
  const regions = regionsParam === null || regionsParam === '__all__' ? '__all__' : regionsParam.split(',').filter(Boolean);
  const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
  try {
    return Response.json(await readResources(params.type, { limit, offset, regions, includeGlobal }));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
