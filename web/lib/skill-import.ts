// web/lib/skill-import.ts
// Phase 3 — Skill upload (zip) + import (GitHub directory). Both extractors return the same shape so
// the route can feed either straight into the existing validateSkill()/upsertSkill() pipeline
// (web/app/api/customization/route.ts's `kind:'skill'` POST branch) — same disabled-by-default,
// human-must-enable flow, no separate review UI needed.
//
// Reference files are stored INLINE in Aurora (skills.reference_keys, repurposed — see
// web/lib/catalog.ts SkillInput.referenceKeys), not in S3: skill reference docs are small
// text/markdown, and this avoids a new bucket + IAM + Terraform apply for what a JSONB column
// already holds.
import AdmZip from 'adm-zip';

export interface ReferenceFile { path: string; content: string; }
export interface ExtractedSkill {
  name?: string;
  description?: string;
  instructions: string;
  referenceFiles: ReferenceFile[];
}

const MAX_FILE_BYTES = 20_000;
const MAX_TOTAL_REFERENCE_BYTES = 100_000;

/** Parse the `---\nname: x\ndescription: y\n---\n<body>` frontmatter used by SKILL.md (mirrors the
 *  SKILL_TEMPLATE example already shown in the customization UI). Tolerant: a missing/malformed
 *  frontmatter block just yields no name/description and the whole text as the body — the caller
 *  (or the admin, before enabling) fills in what's missing. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text };
  const [, front, body] = m;
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  return { name, description, body: body.trim() };
}

export class SkillImportError extends Error {}

/** Extract a skill from an uploaded zip: a SKILL.md (root or one level deep, case-insensitive) is
 *  required; everything else becomes a bounded inline reference file. */
export function extractSkillFromZip(buffer: Uint8Array): ExtractedSkill {
  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(buffer));
  } catch {
    throw new SkillImportError('not a valid zip file');
  }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const skillEntry = entries.find((e) => /^(.*\/)?SKILL\.md$/i.test(e.entryName) && e.entryName.split('/').length <= 2);
  if (!skillEntry) throw new SkillImportError('zip must contain a SKILL.md at its root or one level deep');

  const { name, description, body } = parseSkillFrontmatter(skillEntry.getData().toString('utf8'));
  const referenceFiles = collectReferenceFiles(
    entries.filter((e) => e !== skillEntry).map((e) => ({ path: e.entryName, content: e.getData().toString('utf8') })),
  );
  return { name, description, instructions: body, referenceFiles };
}

function collectReferenceFiles(files: ReferenceFile[]): ReferenceFile[] {
  let total = 0;
  const out: ReferenceFile[] = [];
  for (const f of files) {
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) continue; // skip oversized individual files rather than fail the whole import
    if (total + bytes > MAX_TOTAL_REFERENCE_BYTES) break; // stop once the total cap is hit
    total += bytes;
    out.push(f);
  }
  return out;
}

const GITHUB_DIR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([^/]+)\/(.+)$/;

interface GithubContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
}

async function fetchGithubDir(owner: string, repo: string, branch: string, path: string): Promise<GithubContentEntry[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new SkillImportError(`GitHub directory listing failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new SkillImportError('URL does not point to a directory');
  return data as GithubContentEntry[];
}

async function fetchGithubFile(downloadUrl: string): Promise<string> {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new SkillImportError(`failed to fetch ${downloadUrl} (${res.status})`);
  return await res.text();
}

/** Extract a skill from a public GitHub directory URL (curated/validation-only — never fetches an
 *  arbitrary attacker-supplied URL; the owner/repo/branch/path are parsed out and used to build
 *  requests ONLY against api.github.com / raw.githubusercontent.com). Lists one directory level,
 *  recurses at most one level into sub-directories (e.g. references/) — same shape as the zip path. */
export async function extractSkillFromGithubUrl(url: string): Promise<ExtractedSkill> {
  const m = GITHUB_DIR_URL_RE.exec(url);
  if (!m) throw new SkillImportError('URL must look like https://github.com/<owner>/<repo>/tree/<branch>/<path>');
  const [, owner, repo, branch, path] = m;

  const topLevel = await fetchGithubDir(owner, repo, branch, path);
  const skillMeta = topLevel.find((e) => e.type === 'file' && /^SKILL\.md$/i.test(e.name));
  if (!skillMeta || !skillMeta.download_url) throw new SkillImportError('directory must contain a SKILL.md');
  const { name, description, body } = parseSkillFrontmatter(await fetchGithubFile(skillMeta.download_url));

  const candidateFiles: GithubContentEntry[] = [];
  for (const entry of topLevel) {
    if (entry === skillMeta) continue;
    if (entry.type === 'file') candidateFiles.push(entry);
    else if (entry.type === 'dir' && candidateFiles.length < 20) {
      const sub = await fetchGithubDir(owner, repo, branch, entry.path);
      candidateFiles.push(...sub.filter((e) => e.type === 'file'));
    }
    if (candidateFiles.length >= 20) break; // bound total fetches, mirrors the zip size discipline
  }

  const referenceFiles: ReferenceFile[] = [];
  for (const f of candidateFiles.slice(0, 20)) {
    if (!f.download_url) continue;
    referenceFiles.push({ path: f.path, content: await fetchGithubFile(f.download_url) });
  }
  return { name, description, instructions: body, referenceFiles: collectReferenceFiles(referenceFiles) };
}
