import { describe, expect, it } from 'vitest';
import { buildReportHandoff } from './report-handoff';

const report = {
  id: 71, status: 'partial', tier: 'deep', title: 'Review service reliability',
  created_at: '2026-09-13T08:00:00Z', finished_at: '2026-09-13T08:03:00Z',
  sources_used: ['inventory', 'cost'], summary: {
    drift: [{ id: 2, passed: false }], unassessed: [{ id: 3, passed: null, target: 'PRIVATE' }], degraded: ['posture'],
    invariant_coverage: { total: 3, assessed: 2, passed: 1, failed: 1, unassessed: 1 },
  },
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
      expect(d.text).toContain('Unassessed invariant checks: 1');
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
    'xoxb-HIDDEN_VALUE',
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
      'owner@example.test', 'INLINE_SECRET', 'HTML_SECRET', 'notionsecret', 'gitsecret', 'TITLE_SECRET']) {
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
      expect(d.text).toContain('Unassessed invariant checks: unknown');
      expect(d.text).toContain('Created: unknown');
      expect(d.text).toContain('/ai-diagnosis?report=71');
    }
  });

  it('uses no arbitrary legacy body when known summary sections are absent', () => {
    const handoff = buildReportHandoff(report, '# Legacy\nUNRECOGNIZED_DUMP')!;
    expect(handoff.drafts[0].text).not.toContain('UNRECOGNIZED_DUMP');
    expect(handoff.drafts[0].text).toContain('No narrative included in this excerpt');
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
  it('retains producer markers in the ReportSections fixture format while excluding raw records', () => {
    // Same heading/finding format as ReportSections.test.tsx and diagnosis/sections.py.
    const md = [
      '# AWS 진단 리포트 — 계정 123456789012 (mid)',
      '> 생성 일시: 2026-08-31 10:00 (KST)',
      '**목차**', '- [Executive Summary](#executive_summary)',
      '## Executive Summary', '전반적으로 양호합니다.', '[Info] 추가 근거를 확인하세요.',
      '## Security Posture', '[Critical] 0.0.0.0/0 인그레스 위반이 발견되었습니다.',
      '["DUMP_SECRET"]', '[Info] ["TAGGED_DUMP"]',
      '## Recommendations', '[Warning] gp2 → gp3 전환을 권장합니다.',
    ].join('\n');
    const drafts = buildReportHandoff(report, md)!.drafts;
    for (const draft of drafts) {
      expect(draft.text).toContain('[Info] 추가 근거를 확인하세요.');
      expect(draft.text).not.toMatch(/DUMP_SECRET|TAGGED_DUMP|123456789012/);
    }
    expect(drafts.find(d => d.target === 'security')!.text).toContain('[Critical] 0.0.0.0/0 인그레스 위반이 발견되었습니다.');
    for (const target of ['notion', 'slack', 'wiki']) {
      expect(drafts.find(d => d.target === target)!.text).toContain('[Warning] gp2 → gp3 전환을 권장합니다.');
    }
  });
  it.each([
    { name: 'no active invariants', summary: { drift: [], unassessed: [], invariant_coverage: { total: 0, assessed: 0, passed: 0, failed: 0, unassessed: 0 } },
      expected: ['no active invariants', 'not assessed'] },
    { name: 'unassessed', summary: { drift: [], unassessed: [{ id: 1, passed: null }], invariant_coverage: { total: 1, assessed: 0, passed: 0, failed: 0, unassessed: 1 } },
      expected: ['Invariant assessment: unassessed', 'Assessed: 0/1', 'Invariant violations: unknown', 'Unassessed invariant checks: 1'] },
    { name: 'partial', summary: report.summary,
      expected: ['Invariant assessment: partial', 'Assessed: 2/3', 'Invariant violations: 1', 'Unassessed invariant checks: 1'] },
    { name: 'complete', summary: { drift: [], unassessed: [], invariant_coverage: { total: 2, assessed: 2, passed: 2, failed: 0, unassessed: 0 } },
      expected: ['Invariant assessment: complete', 'Assessed: 2/2', 'Invariant violations: 0'] },
    { name: 'missing', summary: { drift: [], unassessed: [] },
      expected: ['Invariant coverage: missing', 'Invariant violations: unknown'] },
    { name: 'invalid counts', summary: { drift: [], unassessed: [], invariant_coverage: { total: 2, assessed: 2, passed: 2, failed: 0, unassessed: 1 } },
      expected: ['Invariant coverage: invalid', 'Invariant violations: unknown'] },
    { name: 'invalid rows', summary: { drift: [null], unassessed: [], invariant_coverage: { total: 1, assessed: 1, passed: 0, failed: 1, unassessed: 0 } },
      expected: ['Invariant coverage: invalid', 'Invariant violations: unknown'] },
  ])('exports producer invariant coverage honestly: $name', ({ name, summary, expected }) => {
    for (const draft of buildReportHandoff({ ...report, summary }, markdown)!.drafts) {
      for (const text of expected) expect(draft.text).toContain(text);
      expect(draft.text).not.toContain('Recorded findings:');
      if (name === 'no active invariants') expect(draft.text).not.toContain('Invariant violations: 0');
    }
  });
  it('calls unrecognized source keys unknown without exporting their arbitrary values', () => {
    const text = buildReportHandoff({ ...report, sources_used: ['PRIVATE_UNKNOWN'], summary: { degraded: ['PRIVATE_UNKNOWN'] } }, markdown)!.drafts[0].text;
    expect(text).toContain('Collector availability: unknown in this draft');
    expect(text).not.toContain('PRIVATE_UNKNOWN');
  });
  it.each([
    { key: 'datasources_obs', ok: true, degraded: false, data: { instances: [], queried: 0 },
      notes: 'datasource diagnosis disabled (datasource_diagnosis_enabled flag off)',
      coverage: '비활성 (datasource_diagnosis_enabled OFF — 외부 datasource 미활용)' },
    { key: 'datasources_obs', ok: true, degraded: false, data: { instances: [], queried: 0 },
      notes: 'no connected observability datasources',
      coverage: '연결된 datasource/빌드된 신호 없음 — no connected observability datasources' },
    { key: 'posture', ok: true, degraded: false, data: { enabled: false, findings_by_severity: {} },
      notes: 'Security Hub not subscribed in this account/region', coverage: 'empty (no data returned)' },
    { key: 'cw_metrics', ok: true, degraded: false, data: { by_instance: {}, avg_cpu: null },
      notes: 'no ec2 instance ids in inventory', coverage: 'empty (no data returned)' },
    { key: 'cost', ok: false, degraded: true, data: {}, notes: 'collection failed',
      coverage: 'degraded — collection failed' },
  ])('does not turn producer ok flags into enabled collector coverage: $notes', collector => {
    // report.py builds these arrays from _result() flags, not from enabled/queried state.
    const collected = [collector];
    const input = { ...report, sources_used: collected.filter(c => c.ok).map(c => c.key),
      summary: { ...report.summary, degraded: collected.filter(c => c.degraded).map(c => c.key) } };
    const md = markdown + `\n## Data coverage\n- \`${collector.key}\`: ${collector.coverage}`;
    for (const draft of buildReportHandoff(input, md)!.drafts) {
      expect(draft.text).toContain('Collector availability: unknown in this draft');
      expect(draft.text).toContain('authenticated report');
      expect(draft.text).not.toMatch(/Sources recorded:|Degraded sources:/);
    }
  });
  it('puts transferable notices and section omission counts ahead of bounded findings', () => {
    const section = ['[Info] First observation.', '[Info] Second observation.', '[Info] Third observation.',
      '[Critical] Late critical finding.', '[Warning] Late warning finding.'].join('\n');
    const md = `## Executive Summary\n${section}\n## Security Posture\n${section}`;
    const handoff = buildReportHandoff(report, md)!;
    for (const draft of handoff.drafts) {
      for (const notice of handoff.notices) {
        expect(draft.text).toContain(notice);
        expect(draft.text.indexOf(notice)).toBeLessThan(draft.text.indexOf('Report summary (excerpt)'));
      }
      expect(draft.text).toContain('not a complete report');
      expect(draft.text).toContain('2 lines omitted');
      expect(draft.text).toContain('Critical: 1');
      expect(draft.text).toContain('Warning: 1');
      expect(draft.text.indexOf('2 lines omitted')).toBeLessThan(draft.text.indexOf('[Info] First observation.'));
    }
    const security = handoff.drafts.find(d => d.target === 'security')!.text;
    expect(security.match(/2 lines omitted/g)).toHaveLength(2);
    expect(security).not.toContain('Late critical finding.');
  });
  it('accounts for whole-line omissions when the complete transferred draft hits its size budget', () => {
    const line = `[Info] ${'Observation '.repeat(17)}`;
    const section = [line, line, line, '[Critical] Later risk.'].join('\n');
    const handoff = buildReportHandoff({ ...report, title: 'T'.repeat(120) },
      `## Executive Summary\n${section}\n## Recommendations\n${section}`)!;
    for (const draft of handoff.drafts) {
      expect(draft.text.length).toBeLessThanOrEqual(3000);
      for (const notice of handoff.notices) expect(draft.text).toContain(notice);
      expect(draft.text).toContain('Critical: 1');
      expect(draft.text).not.toContain('…[truncated]'); // budget omissions are counted before the final DLP backstop
    }
  });
  it('labels unscanned tails as unknown rather than claiming complete omission counts', () => {
    const md = ('## Executive Summary\n[Info] Seen.\n').padEnd(100_100, '\n') + '[Critical] Unscanned.';
    const handoff = buildReportHandoff(report, md)!;
    for (const draft of handoff.drafts) {
      expect(draft.text).toContain('further omissions are unknown');
      expect(draft.text).toContain('at least 0 lines omitted');
    }
  });
  it('keeps clock times and benign CRLF normalization without a redaction warning', () => {
    const handoff = buildReportHandoff(report, '## Executive Summary\r\n[Info] Latency rose at 10:00:00 and 23:59:59 UTC.\r\n')!;
    expect(handoff.drafts[0].text).toContain('10:00:00 and 23:59:59');
    expect(handoff.drafts[0].text).not.toContain('[address omitted]');
    expect(handoff.notices).not.toContain('Sensitive or non-narrative content was redacted or omitted.');
  });
  it('still masks compressed and full IPv6 addresses', () => {
    const text = buildReportHandoff(report, '## Executive Summary\n[Info] Endpoints fd00::1 and 2001:db8:0:0:0:0:0:1 were inspected.')!.drafts[0].text;
    expect(text).not.toMatch(/fd00::1|2001:db8/);
    expect(text).toContain('[address omitted]');
  });
  it('does not claim evidence is absent when the excerpt excludes its table or section', () => {
    const text = buildReportHandoff(report, '## Executive Summary\n| metric | value |\n## External observability signals\nEvidence in a non-exported section.')!.drafts[0].text;
    expect(text).toContain('No narrative included in this excerpt');
    expect(text).not.toMatch(/request the missing evidence|No eligible prose/);
  });
  it('skips an oversized ordinary line and preserves later findings', () => {
    const md = `## Executive Summary\n${'X'.repeat(5000)}\n[Info] Evidence continues.\n## Recommendations\n[Warning] Review the deployment.`;
    const text = buildReportHandoff(report, md)!.drafts[0].text;
    expect(text).toContain('[Info] Evidence continues.');
    expect(text).toContain('[Warning] Review the deployment.');
  });
  it.each([
    ['```json ' + 'x'.repeat(5000), '```' + ' '.repeat(5000)],
    ['x'.repeat(4500) + '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----' + 'x'.repeat(4500)],
  ])('preserves fence/PEM state while omitting oversized delimiter lines', (start, end) => {
    const text = buildReportHandoff(report, `## Executive Summary\n${start}\nBLOCK_SECRET\n${end}\n[Info] Safe observation.`)!.drafts[0].text;
    expect(text).not.toContain('BLOCK_SECRET');
    expect(text).toContain('[Info] Safe observation.');
  });
});
