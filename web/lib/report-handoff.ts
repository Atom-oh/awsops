import { redactEgress } from './egress-dlp';
import { DIAG_SECTIONS, titleMatches } from './diagnosis-sections';

export interface ReportHandoffData {
  notices: string[];
  drafts: { target: string; label: string; text: string; filename: string }[];
}
interface ReportEvidence {
  id: number; status: string; tier: string; title?: string | null;
  created_at?: string | Date; finished_at?: string | Date | null; sources_used?: unknown; summary?: unknown;
}
export interface InvariantCoverage {
  total: number; assessed: number; passed: number; failed: number; unassessed: number;
}
const COVERAGE_FIELDS = ['total', 'assessed', 'passed', 'failed', 'unassessed'] as const;

/** Shared with the on-screen invariant panel. Count only consistent producer coverage. */
export function invariantCoverage(value: unknown): InvariantCoverage | null {
  const summary = record(value);
  const raw = summary.invariant_coverage;
  const verdictArray = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.every(row => row && typeof row === 'object' && !Array.isArray(row));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !verdictArray(summary.drift) || !verdictArray(summary.unassessed)) return null;
  const values = raw as Record<string, unknown>;
  if (!COVERAGE_FIELDS.every(k => typeof values[k] === 'number'
      && Number.isSafeInteger(values[k]) && (values[k] as number) >= 0)) return null;
  const c = raw as InvariantCoverage;
  return c.total === c.assessed + c.unassessed && c.assessed === c.passed + c.failed
    && c.failed === summary.drift.length && c.unassessed === summary.unassessed.length ? c : null;
}

function invariantSummary(summary: Record<string, unknown>): string {
  const c = invariantCoverage(summary);
  if (!c) return `Invariant coverage: ${summary.invariant_coverage == null ? 'missing' : 'invalid'}. Invariant violations: unknown. Unassessed invariant checks: unknown.`;
  if (c.total === 0) return 'Invariant assessment: no active invariants; not assessed.';
  const state = c.assessed === 0 ? 'unassessed' : c.assessed < c.total ? 'partial' : 'complete';
  return `Invariant assessment: ${state}. Assessed: ${c.assessed}/${c.total}.`
    + (c.assessed ? ` Passed: ${c.passed}.` : '')
    + ` Invariant violations: ${c.assessed ? c.failed : 'unknown'}. Unassessed invariant checks: ${c.unassessed}.`;
}

// These are formatting destinations, never service discovery, credentials or executable actions.
const TARGETS = [
  { key: 'notion', label: 'Notion', section: 'recommendations',
    checks: ['Confirm the document owner and audience.', 'Separate observed findings from proposed follow-up.', 'Track evidence gaps before accepting recommendations.'] },
  { key: 'slack', label: 'Slack', section: 'recommendations',
    checks: ['Confirm the intended audience before pasting.', 'Ask who will verify the highest-priority observation.', 'Link follow-up evidence in the investigation thread.'] },
  { key: 'wiki', label: 'Wiki / Confluence', section: 'recommendations',
    checks: ['Confirm the page owner and review date.', 'Record evidence, decisions and unresolved questions separately.', 'Assign follow-up checks without implying remediation was performed.'] },
  { key: 'devops', label: 'AWS DevOps Agent investigation context', section: 'recent_changes',
    checks: ['Correlate the symptom timeline with recent changes.', 'Verify logs, metrics and dependency evidence for the same window.', 'What read-only check would distinguish the competing hypotheses?'] },
  { key: 'security', label: 'AWS Security Agent security-review context', section: 'security_posture',
    checks: ['Identify the affected trust boundary and required security property.', 'Validate exposure and permissions against current evidence.', 'Which unassessed control needs review before assigning severity?'] },
  { key: 'finops', label: 'FinOps review context', section: 'cost_overview',
    checks: ['Confirm the billing period, currency and cost-data freshness.', 'Validate utilization and commitments before estimating savings.', 'What reliability constraint must a proposed saving preserve?'] },
] as const;
const SOURCES = new Set(['inventory', 'cw_metrics', 'cost', 'idle', 'commitment', 'service_map', 'datasources_obs', 'posture', 'what_changed']);
const MAX_INPUT = 100_000;
const MAX_LINE = 4000;
const PROSE_LIMIT = 650;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function date(value: unknown): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'unknown';
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return 'unknown';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : 'unknown';
}
function sources(value: unknown): string {
  if (!Array.isArray(value)) return 'unknown';
  if (!value.length) return 'none recorded';
  const known = [...new Set(value.filter(v => typeof v === 'string' && SOURCES.has(v)))];
  if (value.some(v => typeof v !== 'string' || !SOURCES.has(v))) known.push('unknown');
  return known.join(', ');
}

/** Format only selected narrative from a known report. Never serialize source records or raw summary
 * objects. The existing regex redactor is best-effort, so also omit code/tables/credential-bearing
 * lines, URLs and identifiers. Manual review remains necessary; this is not an approval to publish.
 * Draft labels/notices are English; extracted report prose keeps its original language. */
export function buildReportHandoff(report: ReportEvidence, markdown: string | null): ReportHandoffData | null {
  if (!Number.isSafeInteger(report.id) || report.id <= 0
      || !['succeeded', 'partial'].includes(report.status) || !markdown?.trim()) return null;
  let omitted = false;
  let truncated = markdown.length > MAX_INPUT;
  const sanitize = (line: string): string => {
    if (line.length > MAX_LINE) { omitted = truncated = true; return ''; }
    // Short secrets are not reliably caught by entropy-based DLP. Drop their entire prose line.
    if (/\b(?:password|passwd|secrets?|tokens?|api[_ -]?key|access[_ -]?key|credentials?|authorization|cookies?|private[_ -]?key)\b|(?:\bBearer|\bBasic)\s+\S+|(?:xox[baprs]-|ntn_|gh[pousr]_)/i.test(line)) {
      omitted = true; return '';
    }
    const masked = line
      .replace(/`[^`]*`/g, '[code omitted]')
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, '[link omitted]')
      .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, '[URL omitted]')
      .replace(/<[^>]*>.*?<\/[^>]*>|<[^>]*>/g, '[markup omitted]')
      .replace(/arn:aws(?:-[a-z-]+)?:[^\s"'<>]+/gi, '[resource omitted]')
      .replace(/\b\d{12}\b/g, '[account omitted]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email omitted]')
      .replace(/\b(?:i|vpc|subnet|sg|eni|vol|snap|ami|nat|igw|tgw)-[0-9a-f]+\b/gi, '[resource omitted]')
      .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]+\b/gi, '[address omitted]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ');
    const redacted = redactEgress(masked);
    if (masked !== line || redacted.redactions.length) omitted = true;
    return redacted.payload.trim();
  };
  const prose = new Map<string, string[]>();
  const allowed = new Set<string>(['executive_summary', ...TARGETS.map(t => t.section)]);
  let section = '';
  let fence: { char: string; size: number } | null = null;
  let pem = false;
  let input = markdown.slice(0, MAX_INPUT);
  // Never retain a partial line: its credential marker may be beyond the input bound.
  if (truncated) input = input.slice(0, Math.max(0, input.lastIndexOf('\n')));
  for (const line of input.split('\n')) {
    const oversized = line.length > MAX_LINE;
    if (oversized) omitted = truncated = true;
    // Linear delimiter scans preserve state even on omitted lines; prose regexes stay bounded.
    if (line.includes('-----BEGIN ')) { pem = true; omitted = true; continue; }
    if (pem) { if (line.includes('-----END ')) pem = false; continue; }
    const leading = line.trimStart();
    if (leading.startsWith('```') || leading.startsWith('~~~')) {
      const char = leading[0];
      let size = 3;
      while (leading[size] === char) size++;
      if (!fence) fence = { char, size };
      else if (char === fence.char && size >= fence.size) fence = null;
      omitted = true; continue;
    }
    if (fence) continue;
    if (oversized) { if (line.startsWith('##')) section = ''; continue; }
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const key = DIAG_SECTIONS.find(s => titleMatches(s, heading[1]))?.key ?? '';
      section = allowed.has(key) ? key : '';
      continue;
    }
    if (!section || !line.trim()) continue;
    // Code, tables, JSON/YAML-like records and raw inventory lines are not narrative.
    const marker = /^\s*\[(?:Critical|Warning|Info)\](?:\s+|$)/.exec(line);
    const payload = marker ? line.slice(marker[0].length) : line;
    if (/^\s{4}|^\t|[|{}]|^\s*#{1,6}\s|^\s*[\w.-]+\s*[:=]/.test(line)
        || /^\s*["'[\]]|^\s*[\w.-]+\s*[:=]\s*["'[{]/.test(payload)) {
      omitted = true; continue;
    }
    const safe = sanitize(line);
    if (!safe) continue;
    const lines = prose.get(section) ?? [];
    if (lines.length >= 3 || lines.join('\n').length >= PROSE_LIMIT) { truncated = true; continue; }
    const remaining = PROSE_LIMIT - lines.join('\n').length - (lines.length ? 1 : 0);
    if (remaining <= 0) { truncated = true; continue; }
    if (safe.length > remaining) truncated = true;
    lines.push(safe.slice(0, remaining));
    prose.set(section, lines);
  }
  const title = sanitize(report.title ?? '').slice(0, 120) || `Diagnosis report #${report.id}`;
  const summary = record(report.summary);
  const tier = ['light', 'mid', 'deep'].includes(report.tier) ? report.tier : 'unknown';
  const common = [
    `Scope: source report's diagnosed account; identifiers omitted. Tier: ${tier}. Status: ${report.status}.`,
    `Created: ${date(report.created_at)}; completed: ${date(report.finished_at)}.`,
    'Collection windows and freshness are source-specific; report creation time is not a measurement window.',
    `Sources recorded: ${sources(report.sources_used)}. Degraded sources: ${sources(summary.degraded)}.`,
    invariantSummary(summary),
    'Missing/unassessed evidence is not healthy zero. Revalidate scope, time and evidence before making decisions.',
    ...(report.status === 'partial' ? ['Partial report: some evidence or sections are incomplete.'] : []),
  ].join('\n');
  const drafts = TARGETS.map(target => {
    const heading = (text: string) => target.key === 'slack' ? `*${text}*` : `## ${text}`;
    const text = [
      heading(`${target.label}: ${title}`),
      'Manual handoff draft — review before transfer. No publishing or external agent invocation.',
      `Source: /ai-diagnosis?report=${report.id} (relative AWSops link; sign-in and report access required)`, '',
      heading('Report summary (excerpt)'),
      (prose.get('executive_summary') ?? []).join('\n') || 'No eligible summary prose; inspect the authenticated source report.',
      '', common,
      '', heading('Review evidence (excerpt)'),
      (prose.get(target.section) ?? []).join('\n') || 'No eligible prose for this review; request the missing evidence.',
      '', heading('Next questions / checks'), ...target.checks.map(check => `- ${check}`),
    ].join('\n');
    const result = redactEgress(text);
    if (result.redactions.includes('size-cap')) truncated = true;
    return { target: target.key, label: target.label, text: result.payload,
      filename: `awsops-report-${report.id}-${target.key}.${target.key === 'slack' ? 'txt' : 'md'}` };
  });
  return { drafts, notices: [
    'Selected prose only; raw inventory, account dumps and source objects are excluded. Review before manual transfer.',
    ...(omitted ? ['Sensitive or non-narrative content was redacted or omitted.'] : []),
    ...(truncated ? ['Excerpts are bounded/truncated; consult the authenticated source for full evidence.'] : []),
  ] };
}
