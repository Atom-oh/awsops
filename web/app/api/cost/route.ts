import { verifyUser } from '@/lib/auth';
import { getMtdCost, getCostTrend, getMonthlyCost, getCostForecast } from '@/lib/aws';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  // SINGLE-account route: the client fans out + aggregates for "All accounts" (thin-BFF).
  const account = new URL(request.url).searchParams.get('account') || undefined;
  if (account === '__all__') {
    return Response.json({ status: 'error', message: 'aggregate across accounts client-side, not via __all__' }, { status: 400 });
  }
  try {
    const mtd = await getMtdCost(account);
    // trend / monthly / forecast are secondary — degrade so the by-service breakdown still renders.
    const trend = await getCostTrend(account).catch(() => []);
    const monthly = await getMonthlyCost(6, account).catch(() => []);
    const forecast = await getCostForecast(account).catch(() => null);
    return Response.json({ ...mtd, trend, monthly, forecast, account: account ?? 'self' });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
