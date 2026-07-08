import { verifyUser } from '@/lib/auth';
import { readResources } from '@/lib/inventory';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { getEcsClusterCosts } from '@/lib/aws';

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
    const page = await readResources(params.type, { limit, offset, regions, includeGlobal });
    // MTD real cost isn't in inventory_resources (Steampipe has no CE access) — merge it in here.
    // Degrades silently: cost-allocation tag not active yet, or CE denied → rows just lack the field.
    if (params.type === 'ecs_cluster') {
      try {
        const costs = await getEcsClusterCosts();
        for (const row of page.rows) {
          const cost = costs[String(row.resource_id)];
          if (cost !== undefined) (row.data as Record<string, unknown>).mtd_cost_usd = cost;
        }
      } catch { /* leave rows without mtd_cost_usd */ }
    }
    return Response.json(page);
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
