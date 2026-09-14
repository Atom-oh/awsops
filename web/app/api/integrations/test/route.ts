import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Administrator-only authentication probe. No client endpoint, tool or secret is accepted. */
export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);
  let body: unknown;
  try { body = await readJsonBounded(request); }
  catch (error) {
    return json({ error: 'invalid request body' }, error instanceof BodyTooLargeError ? 413 : 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (body as { kind?: unknown }).kind !== 'notion') {
    return json({ error: 'only the Notion authentication probe is supported' }, 400);
  }
  try {
    const result = await invokeMcpLambdaTool({ kind: 'notion', tool: 'notion_health' }) as { ok?: boolean };
    return json({ ok: result?.ok === true });
  } catch {
    return json({ ok: false });
  }
}
