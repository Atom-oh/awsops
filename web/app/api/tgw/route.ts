import { verifyUser } from '@/lib/auth';
import { tgwDetails } from '@/lib/tgw';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Transit Gateway 상세: 어태치먼트 + 라우트 테이블(+라우트). ids는 tgw- 접두사만 통과.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',').map((s) => s.trim()).filter((s) => /^tgw-[0-9a-f]+$/.test(s));
  if (ids.length === 0) return Response.json({ attachments: [], routeTables: [] });
  try {
    return Response.json(await tgwDetails(ids));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
