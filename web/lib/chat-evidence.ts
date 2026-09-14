/** Versioned, bounded metadata. Text and successful transport alone are not evidence. */
import type { ChatLang } from './chat-i18n';

export type Outcome = 'success' | 'error' | 'empty' | 'unverified' | 'partial';
export type SourceStatus = 'ok' | 'empty' | 'partial' | 'unavailable' | 'error' | 'unknown';
export interface SourceQuality {
  status: SourceStatus; sourceId?: string; scope?: 'account' | 'aggregate';
  producerStatus?: 'succeeded' | 'failed' | 'partial' | 'running' | 'unknown';
  capturedAtMs?: number | null; lastSuccessAtMs?: number | null; attemptedAtMs?: number | null;
  finishedAtMs?: number | null; itemCount?: number | null; reasons?: string[];
  windowStartMs?: number | null; windowEndMs?: number | null;
}
export interface ReceiptQuality {
  partial?: boolean; unknown?: boolean; truncated?: boolean; invalid?: boolean; unsupported?: boolean;
  selection?: 'all' | 'resolved' | 'not_found' | 'ambiguous';
  routeSelection?: { status: 'selected' | 'unknown'; basis?: 'explicit' | 'main' | null; reason?: string };
  truncation?: { nodes?: boolean; edges?: boolean; node_limit?: number; edge_limit?: number };
  collection?: { status: SourceStatus; stale?: boolean; retainedPrevious?: boolean; snapshotConsistent?: boolean;
    captured_at?: string | null; attempted_at?: string | null; evidenceKind?: 'inventory' | 'trace';
    windowStartMs?: number; windowEndMs?: number; nodeDrops?: number; edgeDrops?: number;
    orphanSpans?: number; invalidSpans?: number; unresolvedMessaging?: number;
    infraUnavailable?: boolean; inputTruncated?: boolean; graphTruncated?: boolean;
    sources?: SourceQuality[]; publishedSources?: SourceQuality[] };
}
/** Last Runtime frame after all receipts. Count is logical call IDs, never deduplicated tool names. */
export interface InvocationCompletion { version: 1; receiptCount: number }
export interface ToolReceipt {
  version: 1; callId: string; tool: string;
  observedAt: number; terminalObservedAt?: number; // delivery clocks, never execution durations
  outcome: Outcome | 'unfinished';
  inputs: Record<string, string>;
  requestedScope: Record<string, string>;
  observedScope: Record<string, string>;
  quality?: ReceiptQuality;
}
export interface DomainOutcome { gateway: string; status: Outcome; receipts: ToolReceipt[]; truncated?: boolean; invalid?: boolean; completion?: InvocationCompletion }
export interface ChatEvidence {
  version: 1; status: Outcome; domains: DomainOutcome[];
  synthesis?: 'interrupted'; fallback?: 'unverified'; truncated?: boolean; invalid?: boolean;
}
const outcomes = ['success', 'error', 'empty', 'unverified', 'partial'];
const statuses = ['ok', 'empty', 'partial', 'unavailable', 'error', 'unknown'];
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const match = (v: unknown, re: RegExp, max = 128): v is string => typeof v === 'string' && v.length <= max && re.test(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8640000000000000;
const id = /^[a-zA-Z0-9_-]+$/;
const account = /^\d{12}$/;
const region = /^[a-z]{2}(?:-[a-z]+){1,2}-\d$/;
const resource = /^(?:eni|sg|vpc|subnet|i|rtb|acl|nat|tgw)-[a-zA-Z0-9-]{1,64}$/;
function strings(v: unknown, fields: Record<string, RegExp>): Record<string, string> {
  const o = obj(v);
  return Object.fromEntries(Object.entries(fields).filter(([k, re]) => match(o[k], re)).map(([k]) => [k, o[k]]));
}
const reasons = new Set(['missing_ledger', 'unknown_account_coverage', 'source_failed', 'incomplete_collection',
  'unknown_attributes', 'empty_not_confirmed', 'unknown_capture', 'publication_failed', 'read_failed',
  'response_missing', 'truncated', 'scope_missing', 'ambiguous', 'missing', 'identity_missing',
  'target_missing', 'destination_missing', 'snapshot_changed']);
function quality(value: unknown): ReceiptQuality {
  const o = obj(value), q: ReceiptQuality = {};
  if (o !== value) q.invalid = true;
  if (Object.keys(o).some(k => !['partial', 'unknown', 'truncated', 'invalid', 'unsupported',
    'selection', 'routeSelection', 'truncation', 'collection'].includes(k))) q.unsupported = true;
  const fields = (src: Record<string, any>, dest: Record<string, any>, rules: Record<string, (v: any) => boolean>,
    otherKeys: string[] = []) => {
    if (Object.keys(src).some(k => !Object.prototype.hasOwnProperty.call(rules, k) && !otherKeys.includes(k))) q.unsupported = true;
    for (const [k, valid] of Object.entries(rules)) if (Object.prototype.hasOwnProperty.call(src, k)) {
      if (valid(src[k])) {
        // Caller-supplied false markers cannot clear a problem found during projection.
        if (dest !== q || !['invalid', 'unsupported', 'truncated'].includes(k) || dest[k] !== true) dest[k] = src[k];
      } else q.invalid = true;
    }
  };
  const oneOf = (values: string[]) => (v: unknown) => typeof v === 'string' && values.includes(v);
  const boolean = (v: unknown) => typeof v === 'boolean';
  const clock = (v: unknown) => v === null || match(v, /^\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?$/, 40);
  fields(o, q, { partial: boolean, unknown: boolean, truncated: boolean, invalid: boolean, unsupported: boolean,
    selection: oneOf(['all', 'resolved', 'not_found', 'ambiguous']) }, ['routeSelection', 'truncation', 'collection']);
  for (const k of ['routeSelection', 'truncation', 'collection']) {
    if (!(k in o)) continue;
    const v = obj(o[k]);
    if (v !== o[k]) { q.invalid = true; continue; }
    if (k === 'routeSelection') {
      q.routeSelection = { status: v.status === 'selected' ? 'selected' : 'unknown' };
      if (!['selected', 'unknown'].includes(v.status)) q.invalid = true;
      fields(v, q.routeSelection, { basis: x => x === null || oneOf(['explicit', 'main'])(x), reason: x => reasons.has(x) }, ['status']);
    } else if (k === 'truncation') {
      q.truncation = {};
      fields(v, q.truncation, { nodes: boolean, edges: boolean, node_limit: num, edge_limit: num });
    } else {
      const c: NonNullable<ReceiptQuality['collection']> = { status: statuses.includes(v.status) ? v.status : 'unknown' };
      if (!statuses.includes(v.status)) q.invalid = true;
      fields(v, c, { stale: boolean, retainedPrevious: boolean, snapshotConsistent: boolean,
        captured_at: clock, attempted_at: clock, evidenceKind: oneOf(['inventory', 'trace']),
        ...Object.fromEntries(['infraUnavailable', 'inputTruncated', 'graphTruncated'].map(k => [k, boolean])),
        ...Object.fromEntries(['windowStartMs', 'windowEndMs', 'nodeDrops', 'edgeDrops', 'orphanSpans', 'invalidSpans', 'unresolvedMessaging'].map(k => [k, num])),
      }, ['status', 'sources', 'publishedSources']);
      for (const name of ['sources', 'publishedSources'] as const) {
        if (!(name in v)) continue;
        c[name] = [];
        if (!Array.isArray(v[name])) { q.invalid = true; continue; }
        if (v[name].length > 8) q.truncated = true;
        for (const raw of v[name].slice(0, 8)) {
          const source = obj(raw);
          if (source !== raw) { q.invalid = true; continue; }
          const record: SourceQuality = { status: statuses.includes(source.status) ? source.status : 'unknown' };
          if (!statuses.includes(source.status)) q.invalid = true;
          fields(source, record, { sourceId: x => match(x, /^(?:inventory:[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*(?::(?:\d+|default))?)$/, 80),
            scope: oneOf(['account', 'aggregate']), producerStatus: oneOf(['succeeded', 'failed', 'partial', 'running', 'unknown']),
            ...Object.fromEntries(['capturedAtMs', 'lastSuccessAtMs', 'attemptedAtMs', 'finishedAtMs', 'itemCount', 'windowStartMs', 'windowEndMs'].map(k => [k, (x: unknown) => x === null || num(x)])) }, ['status', 'reasons']);
          if ('reasons' in source) {
            if (!Array.isArray(source.reasons)) q.invalid = true;
            else {
              record.reasons = source.reasons.slice(0, 6).filter((r: unknown) => typeof r === 'string' && reasons.has(r));
              if (record.reasons!.length !== source.reasons.length) q.truncated = true;
            }
          }
          c[name]!.push(record);
        }
      }
      q.collection = c;
    }
  }
  return q;
}

function incomplete(q: ReceiptQuality): boolean {
  const c = q.collection;
  return !!(q.partial || q.unknown || q.truncated || q.invalid || q.unsupported || ['not_found', 'ambiguous'].includes(q.selection ?? '')
    || q.routeSelection?.status === 'unknown' || q.truncation?.nodes || q.truncation?.edges
    || (c && (c.stale || c.retainedPrevious || c.snapshotConsistent === false || !['ok', 'empty'].includes(c.status)
      || c.infraUnavailable || c.inputTruncated || c.graphTruncated
      || [c.nodeDrops, c.edgeDrops, c.orphanSpans, c.invalidSpans, c.unresolvedMessaging].some(n => typeof n === 'number' && n > 0)
      || [c.sources, c.publishedSources].some(sources => sources?.some(s => !['ok', 'empty'].includes(s.status))))));
}

/** Whitelist projection, including nested quality. Never spread caller metadata into storage. */
export function normalizeReceipt(value: unknown): ToolReceipt | undefined {
  const o = obj(value);
  if (o.version !== 1 || !match(o.callId, id) || !match(o.tool, id) || !num(o.observedAt)
    || ![...outcomes, 'unfinished'].includes(o.outcome)) return;
  const q = 'quality' in o ? quality(o.quality) : {};
  let outcome = o.outcome as ToolReceipt['outcome'];
  if (outcome !== 'unfinished' && (!num(o.terminalObservedAt) || o.terminalObservedAt < o.observedAt)) outcome = 'unverified';
  if (['success', 'empty'].includes(outcome) && incomplete(q)) outcome = 'partial';
  return {
    version: 1, callId: o.callId, tool: o.tool, observedAt: o.observedAt,
    ...(num(o.terminalObservedAt) && o.terminalObservedAt >= o.observedAt ? { terminalObservedAt: o.terminalObservedAt } : {}),
    outcome,
    inputs: strings(o.inputs, { target_account_id: account, account_id: account, region, resource_id: resource,
      eni_id: /^eni-[a-zA-Z0-9-]{1,64}$/, vpc_id: /^vpc-[a-zA-Z0-9-]{1,64}$/ }),
    requestedScope: strings(o.requestedScope, { accountId: account, region, resourceId: resource }),
    observedScope: strings(o.observedScope, { accountId: account, region, resourceId: resource }),
    ...(Object.keys(q).length ? { quality: q } : {}),
  };
}

/** One bounded accumulator per invocation: repeated names retain distinct call IDs. */
export class ReceiptBuffer {
  receipts: ToolReceipt[] = [];
  truncated = false;
  completion?: InvocationCompletion;
  finish(value: unknown) {
    const completion = normalizeCompletion(value);
    if (this.completion || !completion || completion.receiptCount !== this.receipts.length) this.truncated = true;
    if (completion) this.completion = completion;
  }
  add(value: unknown) {
    if (this.completion) this.truncated = true;
    const receipt = normalizeReceipt(value);
    if (!receipt) { this.truncated = true; return; }
    const existing = this.receipts.findIndex(r => r.callId === receipt.callId);
    if (existing >= 0) {
      // Only an unfinished observation may advance. A contradictory terminal replay is unknown.
      if (this.receipts[existing].outcome === 'unfinished') this.receipts.splice(existing, 1);
      else { if (JSON.stringify(this.receipts[existing]) !== JSON.stringify(receipt)) this.truncated = true; return; }
    }
    if (this.receipts.length >= 32 || JSON.stringify(this.receipts).length + JSON.stringify(receipt).length > 16000) {
      this.truncated = true; return;
    }
    this.receipts.push(receipt);
  }
}

function aggregate(states: Outcome[]): Outcome {
  if (!states.length || states.every(s => s === 'unverified')) return 'unverified';
  if (states.every(s => s === 'success')) return 'success';
  if (states.every(s => s === 'empty')) return 'empty';
  if (states.every(s => s === 'empty' || s === 'error')) return 'error';
  return 'partial';
}

export function normalizeCompletion(value: unknown): InvocationCompletion | undefined {
  const o = obj(value);
  if (o.version === 1 && Number.isInteger(o.receiptCount) && o.receiptCount >= 0 && o.receiptCount <= 32) {
    return { version: 1, receiptCount: o.receiptCount };
  }
}

export function domainOutcome(gateway: string, text: string, receipts: unknown[] = [], truncated = false,
  runtimeError = false, completion?: InvocationCompletion, runtimeUnverified = false): DomainOutcome {
  const buffer = new ReceiptBuffer();
  for (const r of receipts) buffer.add(r);
  if (completion !== undefined) buffer.finish(completion);
  const states = buffer.receipts.map(r => r.outcome === 'unfinished' ? 'unverified' : r.outcome) as Outcome[];
  let status = aggregate(states);
  if (runtimeUnverified && ['success', 'empty', 'unverified'].includes(status)) status = 'unverified';
  if (runtimeError) status = text.trim() ? 'partial' : 'error';
  const omitted = truncated || buffer.truncated;
  if ((omitted || !buffer.completion || !text.trim()) && ['success', 'empty'].includes(status)) {
    // A complete empty tool result needs no model prose. Blank prose cannot erase a failed read.
    if (!(status === 'empty' && buffer.completion && !omitted)) status = 'partial';
  }
  return { gateway, status, receipts: buffer.receipts, ...(omitted ? { truncated: true } : {}),
    ...(buffer.completion ? { completion: buffer.completion } : {}) };
}

export function answerEvidence(domains: DomainOutcome[]): ChatEvidence {
  return { version: 1, status: aggregate(domains.map(d => d.status)), domains };
}

/** Incoming uncertainty may constrain a result, but never certify it. */
function conservativeStatus(computed: Outcome, incoming: unknown): Outcome {
  if (incoming === 'error' || incoming === 'partial') return incoming;
  if (incoming === 'unverified') return 'unverified';
  if (incoming === 'empty' && computed === 'success') return 'partial';
  return computed;
}

/** Restore only this version. Omission/invalid markers and uncertainty survive repeated projections. */
export function normalizeEvidence(value: unknown): ChatEvidence | undefined {
  const o = obj(value);
  if (o.version !== 1 || !Array.isArray(o.domains)) return;
  const malformedMarker = (v: Record<string, any>) =>
    ['invalid', 'truncated'].some(k => k in v && typeof v[k] !== 'boolean');
  let invalid = o.invalid === true || malformedMarker(o) || !outcomes.includes(o.status);
  const domains: DomainOutcome[] = o.domains.slice(0, 3).flatMap((value: unknown) => {
    const d = obj(value);
    if (!match(d.gateway, id, 64)) { invalid = true; return []; }
    const normalized = domainOutcome(d.gateway, 'restored',
      Array.isArray(d.receipts) ? d.receipts.slice(0, 33) : [], d.truncated === true || d.receipts?.length > 32,
      false, d.completion);
    normalized.status = conservativeStatus(normalized.status, d.status);
    if (d.invalid === true || malformedMarker(d) || !outcomes.includes(d.status) || !Array.isArray(d.receipts)) {
      normalized.invalid = true;
      if (['success', 'empty'].includes(normalized.status)) normalized.status = 'partial';
    }
    return [normalized];
  });
  const evidence = answerEvidence(domains);
  evidence.status = conservativeStatus(evidence.status, o.status);
  if (o.fallback === 'unverified') evidence.fallback = 'unverified';
  if (o.synthesis === 'interrupted') { evidence.synthesis = 'interrupted'; evidence.status = 'partial'; }
  if (o.truncated === true || o.domains.length > 3) evidence.truncated = true;
  if (invalid) evidence.invalid = true;
  if ((evidence.truncated || invalid) && ['success', 'empty'].includes(evidence.status)) evidence.status = 'partial';
  return evidence;
}

export const evidenceSuccessRateLabels: Record<ChatLang, string> = {
  ko: '근거 확인 성공률', en: 'Evidence-confirmed success rate',
  zh: '证据确认成功率', ja: '根拠確認済み成功率',
};

export const evidenceLabels: Record<ChatLang, Record<Outcome | 'unfinished', string>> = {
  en: { success: 'Tool evidence received', partial: 'Incomplete evidence', error: 'Failed', empty: 'No results',
    unverified: 'Unverified — no confirmed tool evidence', unfinished: 'No terminal result' },
  ko: { success: '도구 근거 수신', partial: '불완전한 근거', error: '실패', empty: '결과 없음',
    unverified: '미검증 — 확인된 도구 근거 없음', unfinished: '최종 결과 없음' },
  zh: { success: '已收到工具证据', partial: '证据不完整', error: '失败', empty: '无结果',
    unverified: '未验证 — 无已确认的工具证据', unfinished: '无最终结果' },
  ja: { success: 'ツールの根拠を受信', partial: '根拠が不完全', error: '失敗', empty: '結果なし',
    unverified: '未検証 — 確認済みのツール根拠なし', unfinished: '最終結果なし' },
};
/** Appended outside model synthesis so missing domains cannot be erased by the model. */
export function evidenceDisclosure(evidence: ChatEvidence, lang: ChatLang): string {
  if (evidence.status === 'success') return '';
  const labels = evidenceLabels[lang];
  const missing = evidence.domains.filter(d => d.status !== 'success')
    .map(d => `${d.gateway} — ${labels[d.status]}`);
  if (evidence.synthesis) missing.push(`synthesis — ${labels.partial}`);
  return `\n\n${labels[evidence.status]}: ${missing.join('; ')}.`;
}
