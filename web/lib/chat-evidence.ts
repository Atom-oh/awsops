/** Versioned, bounded metadata. Text and successful transport alone are not evidence. */
import type { ChatLang } from './chat-i18n';

export type Outcome = 'success' | 'error' | 'empty' | 'unverified' | 'partial';
export interface ToolReceipt {
  version: 1; callId: string; tool: string;
  observedAt: number; terminalObservedAt?: number; // delivery clocks, never execution durations
  outcome: Outcome | 'unfinished';
  inputs: Record<string, string>;
  requestedScope: Record<string, string>;
  observedScope: Record<string, string>;
  quality?: Record<string, any>;
}
export interface DomainOutcome { gateway: string; status: Outcome; receipts: ToolReceipt[]; truncated?: boolean }
export interface ChatEvidence {
  version: 1; status: Outcome; domains: DomainOutcome[];
  synthesis?: 'interrupted'; fallback?: 'unverified';
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
function quality(value: unknown): Record<string, any> {
  const o = obj(value), q: Record<string, any> = {};
  for (const k of ['partial', 'unknown', 'truncated']) if (typeof o[k] === 'boolean') q[k] = o[k];
  if (['all', 'resolved', 'not_found', 'ambiguous'].includes(o.selection)) q.selection = o.selection;
  if (o.routeSelection) {
    const route = obj(o.routeSelection);
    q.routeSelection = { status: route.status === 'selected' ? 'selected' : 'unknown' };
    if (['explicit', 'main'].includes(route.basis)) q.routeSelection.basis = route.basis;
    if (reasons.has(route.reason)) q.routeSelection.reason = route.reason;
  }
  if (o.truncation) q.truncation = Object.fromEntries(['nodes', 'edges']
    .filter(k => typeof o.truncation[k] === 'boolean').map(k => [k, o.truncation[k]]));
  if (q.truncation) for (const k of ['node_limit', 'edge_limit']) if (num(o.truncation[k])) q.truncation[k] = o.truncation[k];
  if (o.collection) {
    const c = obj(o.collection);
    const out: Record<string, any> = { status: statuses.includes(c.status) ? c.status : 'unknown' };
    for (const k of ['stale', 'retainedPrevious', 'snapshotConsistent']) if (typeof c[k] === 'boolean') out[k] = c[k];
    for (const k of ['captured_at', 'attempted_at']) {
      if (c[k] === null || match(c[k], /^\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?$/, 40)) out[k] = c[k];
    }
    if (['inventory', 'trace'].includes(c.evidenceKind)) out.evidenceKind = c.evidenceKind;
    for (const k of ['sources', 'publishedSources']) {
      if (!(k in c)) continue;
      if (!Array.isArray(c[k])) { out[k] = []; q.truncated = true; continue; }
      if (c[k].length > 8) q.truncated = true;
      out[k] = c[k].slice(0, 8).map((value: unknown) => {
        const s = obj(value);
        const source: Record<string, any> = { status: statuses.includes(s.status) ? s.status : 'unknown' };
        if (match(s.sourceId, /^(?:inventory:)?[a-z][a-z0-9_-]*$/, 80)) source.sourceId = s.sourceId;
        if (['account', 'aggregate'].includes(s.scope)) source.scope = s.scope;
        if (['succeeded', 'failed', 'partial', 'running', 'unknown'].includes(s.producerStatus)) source.producerStatus = s.producerStatus;
        for (const clock of ['capturedAtMs', 'lastSuccessAtMs', 'attemptedAtMs', 'finishedAtMs', 'itemCount']) {
          if (s[clock] === null || num(s[clock])) source[clock] = s[clock];
        }
        if (Array.isArray(s.reasons)) source.reasons = s.reasons.slice(0, 6).filter((r: unknown) => typeof r === 'string' && reasons.has(r));
        return source;
      });
    }
    q.collection = out;
  }
  return q;
}

function incomplete(q: Record<string, any>): boolean {
  const c = q.collection;
  return !!(q.partial || q.unknown || q.truncated || ['not_found', 'ambiguous'].includes(q.selection)
    || q.routeSelection?.status === 'unknown' || ['nodes', 'edges'].some(k => q.truncation?.[k] === true)
    || (c && (c.stale || c.retainedPrevious || c.snapshotConsistent === false || !['ok', 'empty'].includes(c.status)
      || ['sources', 'publishedSources'].some(k => c[k]?.some((s: any) => !['ok', 'empty'].includes(s.status))))));
}

/** Whitelist projection, including nested quality. Never spread caller metadata into storage. */
export function normalizeReceipt(value: unknown): ToolReceipt | undefined {
  const o = obj(value);
  if (o.version !== 1 || !match(o.callId, id) || !match(o.tool, id) || !num(o.observedAt)
    || ![...outcomes, 'unfinished'].includes(o.outcome)) return;
  const q = quality(o.quality);
  let outcome = o.outcome as ToolReceipt['outcome'];
  if (outcome !== 'unfinished' && (!num(o.terminalObservedAt) || o.terminalObservedAt < o.observedAt)) outcome = 'unverified';
  if (outcome === 'success' && incomplete(q)) outcome = 'partial';
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
  add(value: unknown) {
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

export function domainOutcome(gateway: string, text: string, receipts: unknown[] = [], truncated = false,
  runtimeError = false): DomainOutcome {
  const buffer = new ReceiptBuffer();
  for (const r of receipts) buffer.add(r);
  const states = buffer.receipts.map(r => r.outcome === 'unfinished' ? 'unverified' : r.outcome) as Outcome[];
  let status: Outcome = runtimeError ? (text.trim() ? 'partial' : 'error')
    : !text.trim() ? 'empty' : aggregate(states);
  if ((truncated || buffer.truncated || buffer.receipts.some(r => r.outcome === 'unfinished')) && status === 'success') status = 'partial';
  return { gateway, status, receipts: buffer.receipts, ...((truncated || buffer.truncated) ? { truncated: true } : {}) };
}

export function answerEvidence(domains: DomainOutcome[]): ChatEvidence {
  return { version: 1, status: aggregate(domains.map(d => d.status)), domains };
}

/** Restore only this version. Unknown/legacy metadata must stay unverified. */
export function normalizeEvidence(value: unknown): ChatEvidence | undefined {
  const o = obj(value);
  if (o.version !== 1 || !Array.isArray(o.domains)) return;
  const domains: DomainOutcome[] = o.domains.slice(0, 3).flatMap((value: unknown) => {
    const d = obj(value);
    if (!match(d.gateway, id, 64)) return [];
    const normalized = domainOutcome(d.gateway, d.status === 'empty' ? '' : 'restored',
      Array.isArray(d.receipts) ? d.receipts.slice(0, 33) : [], d.truncated === true || d.receipts?.length > 32);
    if (['error', 'empty', 'partial'].includes(d.status)) normalized.status = d.status;
    return [normalized];
  });
  if (!domains.length) return;
  const evidence = answerEvidence(domains);
  if (o.fallback === 'unverified') evidence.fallback = 'unverified';
  if (o.synthesis === 'interrupted') { evidence.synthesis = 'interrupted'; evidence.status = 'partial'; }
  if (o.domains.length > 3) evidence.status = 'partial';
  return evidence;
}

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
