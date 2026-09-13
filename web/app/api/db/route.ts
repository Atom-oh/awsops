import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!process.env.AURORA_ENDPOINT) {
    return NextResponse.json({ status: 'unconfigured', message: 'AURORA_ENDPOINT not set' }, { status: 503 });
  }
  try {
    const r = await getPool().query(
      "SELECT count(*)::int AS public_tables FROM pg_tables WHERE schemaname = 'public'",
    );
    return NextResponse.json({
      status: 'ok',
      public_tables: r.rows[0].public_tables,
    });
  } catch (e) {
    // Edge authentication protects this route; it is not in is_public().
    // It is a documented BFF verifyUser carve-out. Keep driver details out of
    // the response even for authenticated callers; return a generic error.
    console.warn(
      JSON.stringify({ evt: 'db_ping_failed', err: e instanceof Error ? e.message : String(e) }),
    );
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
