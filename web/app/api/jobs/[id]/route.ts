import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { verifyUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// pentest-remediation P1-review (MAJOR-2): this route returned worker_jobs.result/artifact_uri/
// error to anyone who could guess/observe a job UUID, with no auth check at all — bypassing the
// revocation this PR added, since Lambda@Edge only checks JWT signature/expiry and knows nothing
// about session_revocations. GET /api/jobs already gates on verifyUser; this sibling route must
// too.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyUser(req.headers.get('cookie')))) {
    return NextResponse.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const id = params.id;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ message: 'invalid job id' }, { status: 400 });
  }
  try {
    const r = await getPool().query(
      `SELECT job_id, type, runtime, status, result, artifact_uri, error, dry_run, attempt, created_at, updated_at
       FROM worker_jobs WHERE job_id = $1`,
      [id],
    );
    if (r.rows.length === 0) {
      return NextResponse.json({ message: 'job not found' }, { status: 404 });
    }
    return NextResponse.json(r.rows[0]);
  } catch (e) {
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
