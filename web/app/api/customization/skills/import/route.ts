// web/app/api/customization/skills/import/route.ts
// Phase 3 — Skill upload (zip) + import (GitHub directory), feeding the SAME validateSkill()/
// upsertSkill() pipeline as the existing `kind:'skill'` POST branch on /api/customization (disabled
// by default; an admin must still review + enable — no separate preview step needed).
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { validateSkill } from '@/lib/skill-validation';
import { upsertSkill, writeAudit } from '@/lib/catalog';
import { extractSkillFromZip, extractSkillFromGithubUrl, SkillImportError, type ExtractedSkill } from '@/lib/skill-import';
import { readBytesBounded, readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

const MAX_ZIP_BYTES = 2_000_000; // skill zips are text/markdown-only; 2MB is generous

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function gate(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return { resp: json({ error: 'unauthenticated' }, 401) };
  if (!(await isAdmin(user))) return { resp: json({ error: 'admin access required' }, 403) };
  if (!process.env.AURORA_ENDPOINT) return { resp: json({ error: 'Aurora not configured' }, 400) };
  return { user };
}

export async function POST(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;

  const contentType = request.headers.get('content-type') || '';
  let extracted: ExtractedSkill;
  try {
    if (contentType.includes('application/zip')) {
      const bytes = await readBytesBounded(request, MAX_ZIP_BYTES);
      extracted = extractSkillFromZip(bytes);
    } else if (contentType.includes('application/json')) {
      const body = (await readJsonBounded(request)) as { source?: string; url?: string };
      if (body.source !== 'github' || typeof body.url !== 'string') {
        return json({ error: "expected {source:'github', url}" }, 400);
      }
      extracted = await extractSkillFromGithubUrl(body.url);
    } else {
      return json({ error: 'content-type must be application/zip or application/json' }, 400);
    }
  } catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'zip too large' }, 413);
    if (e instanceof SkillImportError) return json({ error: e.message }, 400);
    throw e;
  }

  if (!extracted.name || !extracted.description) {
    return json({
      error: 'SKILL.md must declare a name and description in its --- frontmatter',
      detail: { name: extracted.name, description: extracted.description },
    }, 400);
  }

  const v = validateSkill({
    name: extracted.name, description: extracted.description, instructions: extracted.instructions,
    toolAllowlist: [], referenceKeys: extracted.referenceFiles,
  });
  if (!v.ok) return json({ error: 'invalid skill', detail: v.errors }, 400);

  let id: number;
  try {
    id = await upsertSkill({
      name: extracted.name, description: extracted.description, instructions: extracted.instructions,
      toolAllowlist: [], tier: 'custom', createdBy: g.user!.email, referenceKeys: extracted.referenceFiles,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'upsert failed' }, 409); // built-in name collision
  }
  await writeAudit({ actor: g.user!.email ?? g.user!.sub, action: 'upsert', objectType: 'skill', objectId: String(id) });
  return json({ ok: true, id, referenceFileCount: extracted.referenceFiles.length }, 200);
}
