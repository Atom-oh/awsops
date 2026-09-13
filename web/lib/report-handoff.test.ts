import { describe, expect, it } from 'vitest';
import { buildReportHandoff } from './report-handoff';

const report = {
  id: 71, status: 'partial', tier: 'deep', title: 'Review service reliability',
  created_at: '2026-09-13T08:00:00Z', finished_at: '2026-09-13T08:03:00Z',
  sources_used: ['inventory', 'cost'], summary: { drift: [{}], unassessed: [{ target: 'PRIVATE' }], degraded: ['posture'] },
};
const markdown = '# Account 123456789012\n## Executive Summary\nLatency increased; validate the observation window.\n'
  + '## Recommendations\nReview recent changes before proposing a remedy.\n## Network Architecture\nRAW INVENTORY\n';

describe('manual report handoff', () => {
  it('offers six distinct drafts with shared provenance and specialist next checks', () => {
    const handoff = buildReportHandoff(report, markdown)!;
    expect(handoff.drafts.map(d => d.target)).toEqual(['notion', 'slack', 'wiki', 'devops', 'security', 'finops']);
    for (const d of handoff.drafts) {
      expect(d.text).toContain('/ai-diagnosis?report=71');
      expect(d.text).toContain('2026-09-13T08:00:00.000Z');
      expect(d.text).toContain('deep');
      expect(d.text).toContain('partial');
      expect(d.text).toContain('Unassessed checks: 1');
      expect(d.text).toContain('Latency increased');
      expect(d.text).toMatch(/manual/i);
      expect(d.text).not.toContain('123456789012');
      expect(d.text).not.toContain('PRIVATE');
      expect(d.text).not.toContain('RAW INVENTORY');
      expect(d.text.length).toBeLessThanOrEqual(3000);
    }
    expect(handoff.drafts.find(d => d.target === 'devops')!.text).toMatch(/timeline/i);
    expect(handoff.drafts.find(d => d.target === 'security')!.text).toMatch(/trust boundary/i);
    expect(handoff.drafts.find(d => d.target === 'finops')!.text).toMatch(/billing period/i);
    expect(new Set(handoff.drafts.map(d => d.text)).size).toBe(6);
  });

  it.each([
    'The password is HIDDEN_VALUE.',
    'api_key: HIDDEN_VALUE',
    'See https://internal.example/HIDDEN_VALUE',
    'Inline `HIDDEN_VALUE` should be excluded.',
    '<script>HIDDEN_VALUE</script>',
    '"HIDDEN_VALUE",',
    'arn:aws-us-gov:s3:::HIDDEN_VALUE',
    'ntn_HIDDEN_VALUE',
  ])('individually sanitizes narrative: %s', line => {
    const handoff = buildReportHandoff(report, `## Executive Summary\n${line}`)!;
    expect(JSON.stringify(handoff)).not.toContain('HIDDEN_VALUE');
  });

  it('omits code, tables, dumps, links and credential-bearing lines before external draft formatting', () => {
    const unsafe = `## Executive Summary
Safe observation.
\`\`\`text
## Recommendations
CODE_SECRET
\`\`\`
| resource | INVENTORY_SECRET |
{"accounts": ["DUMP_SECRET"]}
password: tiny
token = short
apiKey: hidden
Authorization: Basic abc
-----BEGIN PRIVATE KEY-----
PEM_SECRET
-----END PRIVATE KEY-----
Account 123456789012 uses 10.0.0.1 and arn:aws:s3:::private-bucket.
[evidence](https://evil.example/?password=linksecret)
https://example.test/raw?data=URL_SECRET
Contact owner@example.test.
Inline \`INLINE_SECRET\` and <script>HTML_SECRET</script>.
Bearer shortvalue
xoxb-slacksecret ntn_notionsecret ghp_gitsecret
## Recommendations
Check evidence before remediation.`;
    const handoff = buildReportHandoff({ ...report, title: 'api_key=TITLE_SECRET' }, unsafe)!;
    const out = handoff.drafts.map(d => d.text).join('\n');
    for (const secret of ['CODE_SECRET', 'INVENTORY_SECRET', 'DUMP_SECRET', 'tiny', 'shortvalue', 'hidden',
      'PEM_SECRET', '123456789012', '10.0.0.1', 'private-bucket', 'evil.example', 'URL_SECRET',
      'owner@example.test', 'INLINE_SECRET', 'HTML_SECRET', 'slacksecret', 'notionsecret', 'gitsecret', 'TITLE_SECRET']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('Safe observation');
    expect(handoff.notices.join(' ')).toMatch(/omitted|redact/i);
  });

  it('bounds extraction and discloses unknown evidence instead of manufacturing healthy zeroes', () => {
    const handoff = buildReportHandoff({ ...report, summary: {}, created_at: 'bad-date' },
      '## Executive Summary\n' + 'Observation '.repeat(50_000))!;
    expect(handoff.notices.join(' ')).toMatch(/truncat|bounded/i);
    for (const d of handoff.drafts) {
      expect(d.text.length).toBeLessThanOrEqual(3000);
      expect(d.text).toContain('Unassessed checks: unknown');
      expect(d.text).toContain('Created: unknown');
      expect(d.text).toContain('/ai-diagnosis?report=71');
    }
  });

  it('uses no arbitrary legacy body when known summary sections are absent', () => {
    const handoff = buildReportHandoff(report, '# Legacy\nUNRECOGNIZED_DUMP')!;
    expect(handoff.drafts[0].text).not.toContain('UNRECOGNIZED_DUMP');
    expect(handoff.drafts[0].text).toContain('No eligible summary prose');
  });

  it.each(['running', 'failed'])('does not export a %s report', status => {
    expect(buildReportHandoff({ ...report, status }, markdown)).toBeNull();
  });
  it('does not export absent artifacts or unsafe report IDs', () => {
    expect(buildReportHandoff(report, null)).toBeNull();
    expect(buildReportHandoff({ ...report, id: -1 }, markdown)).toBeNull();
  });
  it('preserves pg timestamp Date objects before JSON serialization', () => {
    const handoff = buildReportHandoff({ ...report, created_at: new Date(report.created_at),
      finished_at: new Date(report.finished_at) }, markdown)!;
    expect(handoff.drafts[0].text).toContain('Created: 2026-09-13T08:00:00.000Z; completed: 2026-09-13T08:03:00.000Z');
  });
  it('drops oversized lines and titles before delimiter regexes', () => {
    const long = 'OVERSIZE_LINE ' + '['.repeat(4500);
    const handoff = buildReportHandoff({ ...report, title: long }, `## Executive Summary\n${long}`)!;
    expect(JSON.stringify(handoff)).not.toContain('OVERSIZE_LINE');
    expect(handoff.notices.join(' ')).toMatch(/truncated/);
  });
  it('discards an incomplete input-tail line rather than leaking a partial credential', () => {
    const prefix = '# Preamble\n'.padEnd(99_960, '\n') + '## Executive Summary\n';
    const handoff = buildReportHandoff(report, prefix + 'TAIL_VALUE ' + 'x'.repeat(4500) + ' token=private')!;
    expect(JSON.stringify(handoff)).not.toContain('TAIL_VALUE');
  });
});
