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
// 리뷰 MAJOR(확정): scopeCacheKey는 정렬된 리전 목록 그대로를 캐시 키로 쓰므로, 길이
// 제한이 없으면 실제 리전의 부분집합을 계속 바꿔 요청하는 것만으로 매번 새 캐시 키가
// 생겨 4분 TTL을 무한히 우회하고(계정 공유 쿼터에 매 요청 풀 스캔) sg-analysis.ts의
// detailCacheByScope/ipLabelCacheByScope에 스코프별 Map을 계속 새로 쌓는다(OOM
// 민감한 Fargate web 티어에서 무제한 증가). 실사용(페이지의 계정/리전 선택)은 한
// 화면에 표시되는 리전 몇 개를 넘지 않으므로 넉넉한 상한으로 그 외의 조합 폭증을 막는다.
const MAX_SCOPE_REGIONS = 20;
function parseRegions(url: URL): string[] | undefined {
  const raw = url.searchParams.get('regions');
  if (!raw) return undefined;
  const regions = raw.split(',').map((r) => r.trim()).filter((r) => REGION_RE.test(r));
  return regions.length > 0 ? [...new Set(regions)].slice(0, MAX_SCOPE_REGIONS) : undefined;
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
