import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { topicArn, publishTest } from '@/lib/diagnosis-notify';

// Test-notification send (gap-audit L53, v1 parity). Admin-only, no body: publishes one SNS test
// message to the diagnosis topic so a freshly confirmed subscriber can verify delivery. Same
// gates as the sibling subscribe/unsubscribe mutations; a publish failure surfaces as 502 —
// never a silent success. This is a notification to the app's own topic — a governed
// external-comms write per ADR-013 (ADR-040/041 lineage), not an AWS-resource mutation.
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return NextResponse.json({ message: 'admin only' }, { status: 403 });
  const arn = topicArn();
  if (!arn) return NextResponse.json({ message: 'notifications disabled' }, { status: 404 });
  try {
    const messageId = await publishTest(arn, user.email ?? user.sub);
    return NextResponse.json({ messageId: messageId ?? null });
  } catch (e) {
    // Log the detail server-side only — SNS auth errors embed role/topic ARNs (sibling routes
    // return generic messages for the same reason).
    console.error('diagnosis test publish failed:', e);
    return NextResponse.json({ message: 'publish failed' }, { status: 502 });
  }
}
