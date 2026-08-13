import { verifyUser } from '@/lib/auth';
import { sgAnalysis, sgHits } from '@/lib/sg-analysis';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

// Security Group 분석: 사용 유무(ENI 부착+상호참조) + 룰 소스/목적지 식별.
// ?view=hits&id=sg-... → 선택 SG 히트 매칭 (Flow Logs 우선, NFM 폴백).
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('view') === 'hits') {
      const id = url.searchParams.get('id') ?? '';
      if (!/^sg-[0-9a-f]{8,17}$/.test(id)) {
        return Response.json({ status: 'error', message: 'invalid sg id' }, { status: 400 });
      }
      const rangeRaw = Number(url.searchParams.get('range') ?? 86400);
      const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 86400;
      return Response.json(await sgHits(id, range));
    }
    return Response.json(await sgAnalysis());
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
