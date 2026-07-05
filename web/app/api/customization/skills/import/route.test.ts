import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SkillImportError } from '@/lib/skill-import';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const upsertSkill = vi.fn();
const writeAudit = vi.fn();
const extractSkillFromZip = vi.fn();
const extractSkillFromGithubUrl = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/catalog', () => ({
  upsertSkill: (...a: unknown[]) => upsertSkill(...a),
  writeAudit: (...a: unknown[]) => writeAudit(...a),
}));
vi.mock('@/lib/skill-import', async () => {
  const actual = await vi.importActual<typeof import('@/lib/skill-import')>('@/lib/skill-import');
  return {
    ...actual,
    extractSkillFromZip: (...a: unknown[]) => extractSkillFromZip(...a),
    extractSkillFromGithubUrl: (...a: unknown[]) => extractSkillFromGithubUrl(...a),
  };
});

function zipReq(body: Uint8Array, cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization/skills/import', {
    method: 'POST', headers: { 'content-type': 'application/zip', cookie }, body,
  });
}
function githubReq(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization/skills/import', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
}

const EXTRACTED = { name: 'rds-perf', description: 'RDS perf', instructions: 'body', referenceFiles: [{ path: 'a.md', content: 'x' }] };

beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); upsertSkill.mockReset(); writeAudit.mockReset();
  extractSkillFromZip.mockReset(); extractSkillFromGithubUrl.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a', email: 'admin@x' });
  isAdmin.mockResolvedValue(true);
  process.env.AURORA_ENDPOINT = 'h';
  extractSkillFromZip.mockReturnValue(EXTRACTED);
  extractSkillFromGithubUrl.mockResolvedValue(EXTRACTED);
  upsertSkill.mockResolvedValue(11);
});

describe('POST /api/customization/skills/import — gate', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(zipReq(new Uint8Array([1])))).status).toBe(401);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(zipReq(new Uint8Array([1])))).status).toBe(403);
  });
});

describe('POST /api/customization/skills/import — zip', () => {
  it('extracts + creates a disabled-by-default skill', async () => {
    const { POST } = await import('./route');
    const res = await POST(zipReq(new Uint8Array([1, 2, 3])));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: 11, referenceFileCount: 1 });
    expect(upsertSkill).toHaveBeenCalledWith(expect.objectContaining({
      name: 'rds-perf', description: 'RDS perf', instructions: 'body', tier: 'custom', createdBy: 'admin@x',
      referenceKeys: EXTRACTED.referenceFiles,
    }));
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ objectType: 'skill', objectId: '11' }));
  });

  it('400 when the zip has no name/description in frontmatter', async () => {
    extractSkillFromZip.mockReturnValue({ instructions: 'body', referenceFiles: [] });
    const { POST } = await import('./route');
    expect((await POST(zipReq(new Uint8Array([1])))).status).toBe(400);
    expect(upsertSkill).not.toHaveBeenCalled();
  });

  it('400 when SkillImportError is thrown (e.g. no SKILL.md)', async () => {
    extractSkillFromZip.mockImplementation(() => { throw new SkillImportError('no SKILL.md'); });
    const { POST } = await import('./route');
    expect((await POST(zipReq(new Uint8Array([1])))).status).toBe(400);
  });

  it('409 on a built-in name collision', async () => {
    upsertSkill.mockRejectedValue(new Error('name conflicts with a built-in skill'));
    const { POST } = await import('./route');
    expect((await POST(zipReq(new Uint8Array([1])))).status).toBe(409);
  });
});

describe('POST /api/customization/skills/import — github', () => {
  it('imports from a github directory URL', async () => {
    const { POST } = await import('./route');
    const res = await POST(githubReq({ source: 'github', url: 'https://github.com/acme/runbooks/tree/main/s' }));
    expect(res.status).toBe(200);
    expect(extractSkillFromGithubUrl).toHaveBeenCalledWith('https://github.com/acme/runbooks/tree/main/s');
  });

  it('400 on a malformed request body', async () => {
    const { POST } = await import('./route');
    expect((await POST(githubReq({ url: 'https://github.com/x/y/tree/main/s' }))).status).toBe(400); // missing source
  });
});

describe('POST /api/customization/skills/import — content-type', () => {
  it('400 on an unsupported content-type', async () => {
    const req = new Request('http://x/api/customization/skills/import', {
      method: 'POST', headers: { 'content-type': 'text/plain', cookie: 'awsops_token=t' }, body: 'x',
    });
    const { POST } = await import('./route');
    expect((await POST(req)).status).toBe(400);
  });
});
