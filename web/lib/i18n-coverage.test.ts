// Gap L186/L206/L207/L254 (batch 40): the v1-gap audit flagged the inventory pages
// (cloudfront/dynamodb/waf render through the generic [type] page) and the datasources UI
// as hardcoded-Korean. The tt() mechanism only translates REGISTERED literals — an
// unregistered string passes through silently — so this lockstep test extracts every Korean
// tt('...') literal on those exact surfaces and asserts it resolves in en/zh/ja (TERMS or a
// RULE). A new Korean literal on these surfaces without a registration fails here with the
// missing string named. Column/spec labels are deliberately English (repo convention:
// technical identifiers stay English across locales) and are out of scope.
import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { applyTerms } from './i18n-terms';

const SURFACES = [
  'app/inventory/[type]/page.tsx',
  ...globSync('app/integrations/datasources/*.tsx').filter((f) => !f.includes('.test.')),
  ...globSync('components/datasources/*.tsx').filter((f) => !f.includes('.test.')),
];

function koreanTtLiterals(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/tt\('((?:[^'\\]|\\.)+)'\)/g)) {
    const lit = m[1].replace(/\\'/g, "'");
    if (/[가-힣]/.test(lit)) out.push(lit);
  }
  return out;
}

describe('i18n coverage on the gap-audit surfaces (L186/L206/L207/L254)', () => {
  it('every Korean tt() literal on the inventory [type] page and datasources UI resolves in en/zh/ja', () => {
    const missing: string[] = [];
    let scanned = 0;
    for (const f of SURFACES) {
      for (const lit of koreanTtLiterals(f)) {
        scanned += 1;
        for (const lang of ['en', 'zh', 'ja'] as const) {
          const translated = applyTerms(lang, lit);
          // an unregistered literal passes through unchanged — that IS the failure
          if (translated === lit) { missing.push(`${f}: ${lit} [${lang}]`); break; }
        }
      }
    }
    expect(SURFACES.length).toBeGreaterThan(3); // the glob must actually find the surfaces
    expect(scanned).toBeGreaterThan(30);         // and real literals — an empty scan proves nothing
    expect(missing, `unregistered Korean literals:\n${missing.join('\n')}`).toEqual([]);
  });
});
