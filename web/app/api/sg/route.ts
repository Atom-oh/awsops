import { verifyUser } from '@/lib/auth';
import { sgAnalysis, sgHits } from '@/lib/sg-analysis';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

// AWS 리전 형식만 허용(예: ap-northeast-2) — DB 쿼리 파라미터로 그대로 들어가므로 형식 검증.
const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

// 리뷰 MAJOR(확정): 스코프 파라미터가 없으면 /api/sg는 항상 호스트 계정 전 리전을 스캔해
// 페이지 상단의 계정/리전 선택과 무관하게 보였다(형제 TgwSection은 scope-filtered rows의
// ids를 서버에 넘겨 스코핑) — ?regions=로 현재 뷰의 SG 인벤토리 행이 속한 리전만 스캔하도록
// SgAnalysisSection이 넘긴다.
function parseRegions(url: URL): string[] | undefined {
  const raw = url.searchParams.get('regions');
  if (!raw) return undefined;
  const regions = raw.split(',').map((r) => r.trim()).filter((r) => REGION_RE.test(r));
  return regions.length > 0 ? [...new Set(regions)] : undefined;
}

// Security Group 분석: 사용 유무(ENI 부착+상호참조) + 룰 소스/목적지 식별.
// ?regions=a,b → 해당 리전만 스캔(페이지 스코프와 동일 범위). 안 주면 인벤토리 전 리전.
// ?view=hits&id=sg-... → 선택 SG 히트 매칭 (Flow Logs 우선, NFM 폴백).
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const regions = parseRegions(url);
  try {
    if (url.searchParams.get('view') === 'hits') {
      const id = url.searchParams.get('id') ?? '';
      if (!/^sg-[0-9a-f]{8,17}$/.test(id)) {
        return Response.json({ status: 'error', message: 'invalid sg id' }, { status: 400 });
      }
      const rangeRaw = Number(url.searchParams.get('range') ?? 86400);
      const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 86400;
      return Response.json(await sgHits(id, range, regions));
    }
    return Response.json(await sgAnalysis(regions));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
