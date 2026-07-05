import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdmZip from 'adm-zip';
import { parseSkillFrontmatter, extractSkillFromZip, extractSkillFromGithubUrl, SkillImportError } from './skill-import';

describe('parseSkillFrontmatter', () => {
  it('parses name/description from a --- frontmatter block', () => {
    const text = '---\nname: rds-perf\ndescription: RDS performance investigation\n---\n\n# Steps\n1. do it\n';
    const r = parseSkillFrontmatter(text);
    expect(r.name).toBe('rds-perf');
    expect(r.description).toBe('RDS performance investigation');
    expect(r.body).toBe('# Steps\n1. do it');
  });

  it('tolerates missing frontmatter — whole text becomes the body', () => {
    const r = parseSkillFrontmatter('# just a body, no frontmatter');
    expect(r.name).toBeUndefined();
    expect(r.description).toBeUndefined();
    expect(r.body).toBe('# just a body, no frontmatter');
  });
});

describe('extractSkillFromZip', () => {
  function zipWith(files: Record<string, string>): Buffer {
    const zip = new AdmZip();
    for (const [path, content] of Object.entries(files)) zip.addFile(path, Buffer.from(content, 'utf8'));
    return zip.toBuffer();
  }

  it('extracts SKILL.md at the root + collects reference files', () => {
    const buf = zipWith({
      'SKILL.md': '---\nname: cis-pack\ndescription: CIS checks\n---\nBody text',
      'references/checklist.md': '# checklist',
    });
    const out = extractSkillFromZip(buf);
    expect(out.name).toBe('cis-pack');
    expect(out.description).toBe('CIS checks');
    expect(out.instructions).toBe('Body text');
    expect(out.referenceFiles).toEqual([{ path: 'references/checklist.md', content: '# checklist' }]);
  });

  it('finds SKILL.md one level deep (case-insensitive)', () => {
    const buf = zipWith({ 'my-skill/skill.md': 'no frontmatter body' });
    const out = extractSkillFromZip(buf);
    expect(out.instructions).toBe('no frontmatter body');
  });

  it('throws SkillImportError when no SKILL.md is present', () => {
    const buf = zipWith({ 'readme.md': 'not a skill file' });
    expect(() => extractSkillFromZip(buf)).toThrow(SkillImportError);
  });

  it('throws SkillImportError on a non-zip buffer', () => {
    expect(() => extractSkillFromZip(new Uint8Array([1, 2, 3]))).toThrow(SkillImportError);
  });

  it('skips an oversized individual reference file rather than failing the whole import', () => {
    const buf = zipWith({
      'SKILL.md': 'body',
      'references/huge.md': 'x'.repeat(30_000),
      'references/small.md': 'ok',
    });
    const out = extractSkillFromZip(buf);
    expect(out.referenceFiles).toEqual([{ path: 'references/small.md', content: 'ok' }]);
  });
});

describe('extractSkillFromGithubUrl', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  function stubFetch(handler: (url: string) => unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const data = handler(url);
      if (data === null) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      if (typeof data === 'string') return { ok: true, status: 200, text: async () => data, json: async () => JSON.parse(data) };
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
    }));
  }

  it('rejects a non-github or malformed URL before making any request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(extractSkillFromGithubUrl('https://evil.example.com/x')).rejects.toBeInstanceOf(SkillImportError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches the directory listing, requires SKILL.md, collects flat reference files', async () => {
    stubFetch((url) => {
      if (url.includes('/contents/skills/rds-perf?')) {
        return [
          { name: 'SKILL.md', path: 'skills/rds-perf/SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' },
          { name: 'checklist.md', path: 'skills/rds-perf/checklist.md', type: 'file', download_url: 'https://raw.example/checklist.md' },
        ];
      }
      if (url === 'https://raw.example/SKILL.md') return '---\nname: rds-perf\ndescription: d\n---\nBody';
      if (url === 'https://raw.example/checklist.md') return '# checklist';
      return null;
    });
    const out = await extractSkillFromGithubUrl('https://github.com/acme/runbooks/tree/main/skills/rds-perf');
    expect(out.name).toBe('rds-perf');
    expect(out.instructions).toBe('Body');
    expect(out.referenceFiles).toEqual([{ path: 'skills/rds-perf/checklist.md', content: '# checklist' }]);
  });

  it('recurses one level into a sub-directory', async () => {
    stubFetch((url) => {
      if (url.includes('/contents/s?')) {
        return [
          { name: 'SKILL.md', path: 's/SKILL.md', type: 'file', download_url: 'https://raw.example/SKILL.md' },
          { name: 'references', path: 's/references', type: 'dir', download_url: null },
        ];
      }
      if (url.includes('/contents/s%2Freferences?') || url.includes('/contents/s/references?')) {
        return [{ name: 'a.md', path: 's/references/a.md', type: 'file', download_url: 'https://raw.example/a.md' }];
      }
      if (url === 'https://raw.example/SKILL.md') return 'body';
      if (url === 'https://raw.example/a.md') return 'nested content';
      return null;
    });
    const out = await extractSkillFromGithubUrl('https://github.com/acme/runbooks/tree/main/s');
    expect(out.referenceFiles).toEqual([{ path: 's/references/a.md', content: 'nested content' }]);
  });

  it('throws when the directory has no SKILL.md', async () => {
    stubFetch(() => [{ name: 'readme.md', path: 's/readme.md', type: 'file', download_url: 'x' }]);
    await expect(extractSkillFromGithubUrl('https://github.com/acme/runbooks/tree/main/s')).rejects.toBeInstanceOf(SkillImportError);
  });
});
