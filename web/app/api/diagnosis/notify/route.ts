import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPool } from '@/lib/db';
import { readJsonBounded } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

// Diagnosis email-notification pause toggle (gap L178, v1 parity): lets an admin pause the
// SNS report/digest emails WITHOUT a deploy (the feature itself stays Terraform-gated by the
// topic's existence). One Aurora row in app_settings — no AWS mutation, not ADR-005 surface.
// Absent key = not paused (today's behavior). The digest worker reads the same key.

const KEY = 'diagnosis_notify_paused';

async function readPaused(): Promise<boolean> {
  const r = await getPool().query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`, [KEY],
  );
  return r.rows[0]?.value === 'true';
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  try {
    return NextResponse.json({ paused: await readPaused(), canManage: await isAdmin(user) });
  } catch (e) {
    return NextResponse.json({ message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return NextResponse.json({ message: 'forbidden: admin only' }, { status: 403 });
  let paused: boolean;
  try {
    const body = (await readJsonBounded(request)) as { paused?: unknown };
    if (typeof body?.paused !== 'boolean') throw new Error('paused must be boolean');
    paused = body.paused;
  } catch {
    return NextResponse.json({ message: 'invalid body' }, { status: 400 });
  }
  try {
    await getPool().query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, paused ? 'true' : 'false'],
    );
    return NextResponse.json({ paused });
  } catch (e) {
    return NextResponse.json({ message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
