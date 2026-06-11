import { verifyUser } from '@/lib/auth';
import { getMtdCost, getCostTrend, getMonthlyCost, getCostForecast } from '@/lib/aws';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const mtd = await getMtdCost();
    // trend / monthly / forecast are secondary — degrade so the by-service breakdown still renders.
    const trend = await getCostTrend().catch(() => []);
    const monthly = await getMonthlyCost().catch(() => []);
    const forecast = await getCostForecast().catch(() => null);
    return Response.json({ ...mtd, trend, monthly, forecast });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
