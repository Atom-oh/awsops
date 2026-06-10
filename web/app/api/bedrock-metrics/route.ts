import { verifyUser } from '@/lib/auth';
import { bedrockModelMetrics } from '@/lib/metrics';
import { RANGE_CONFIGS } from '@/lib/bedrock';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const range = new URL(request.url).searchParams.get('range') || '24h';
  const safeRange = RANGE_CONFIGS[range] ? range : '24h';
  try {
    const data = await bedrockModelMetrics(safeRange);
    return Response.json({ range: safeRange, ...data });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
