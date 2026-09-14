import { describe, it, expect } from 'vitest';
import { domainOutcome, normalizeEvidence, normalizeReceipt, ReceiptBuffer, answerEvidence } from './chat-evidence';

const receipt = (callId: string, outcome = 'success') => ({
  version: 1, callId, tool: 'network___inspect', observedAt: 1000, terminalObservedAt: 2000,
  outcome, inputs: {}, requestedScope: { accountId: '123456789012' }, observedScope: {},
});

describe('saved evidence boundaries', () => {
  it('retains incomplete synthesis after saving otherwise successful domains', () => {
    const d = domainOutcome('network', 'answer', [receipt('a')]);
    const saved = { ...answerEvidence([d]), synthesis: 'interrupted' };
    expect(normalizeEvidence(saved)?.status).toBe('partial');
    expect((normalizeEvidence(saved) as any)?.synthesis).toBe('interrupted');
  });
  it.each([
    [['success', 'error'], 'partial'],
    [['error'], 'error'],
    [['empty'], 'empty'],
    [['success', 'unfinished'], 'partial'],
    [[], 'unverified'],
  ])('preserves terminal outcomes %j in saved/restored domains', (states, expected) => {
    const domain = domainOutcome('network', 'answer', (states as string[]).map((s, i) => receipt(`call-${i}`, s)), false, false, { version: 1, receiptCount: states.length });
    expect(domain.status).toBe(expected);
    expect(normalizeEvidence(answerEvidence([domain]))?.domains[0].status).toBe(expected);
  });
  it('bounds repeated-call evidence and refuses a contradictory replay', () => {
    const b = new ReceiptBuffer();
    for (let i = 0; i < 100; i++) b.add(receipt(`call-${i}`));
    b.add(receipt('call-0', 'error'));
    expect(b.receipts.length).toBeLessThanOrEqual(32);
    expect(b.truncated).toBe(true);
    expect(domainOutcome('network', 'answer', b.receipts, b.truncated).status).toBe('partial');
  });
  it('keeps missing observed scope unknown and projects both source clocks without raw payloads', () => {
    const r = normalizeReceipt({ ...receipt('a'), quality: { collection: {
      status: 'error', stale: true, retainedPrevious: true, captured_at: '2026-09-14T00:00:00Z',
      sources: [{ sourceId: 'inventory:alb', status: 'error', capturedAtMs: 1000, secret: 'SECRET' }],
      publishedSources: [{ sourceId: 'inventory:alb', status: 'ok', capturedAtMs: 500 }],
    } }, inputs: { query: 'SECRET', url: 'https://u:SECRET@host', region: 'us-east-1' } });
    expect(r?.outcome).toBe('partial');
    expect(r?.observedScope).toEqual({});
    expect(r?.quality?.collection.sources[0].capturedAtMs).toBe(1000);
    expect(r?.quality?.collection.publishedSources[0].capturedAtMs).toBe(500);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
  it('does not certify metadata with malformed quality and no terminal observation', () => {
    const r = normalizeReceipt({ ...receipt('a'), terminalObservedAt: undefined,
      quality: { collection: { status: { raw: 'SECRET' }, sources: 'SECRET' } } });
    expect(r?.outcome).toBe('unverified');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('review completeness regressions', () => {
  it.each(['constructor', '__proto__', 'toString'])('unsupported own %s keys cannot disappear from nested quality', key => {
    const extension = JSON.parse(`{"status":"ok","${key}":false}`);
    for (const collection of [extension, { status: 'ok', sources: [extension] }, { status: 'ok', publishedSources: [extension] }]) {
      const r = normalizeReceipt({ ...receipt('a'), quality: { collection } });
      expect(r?.outcome).toBe('partial');
      expect(r?.quality?.unsupported).toBe(true);
      const domain = domainOutcome('network', 'answer', [r], false, false, { version: 1, receiptCount: 1 });
      expect(normalizeEvidence(normalizeEvidence(answerEvidence([domain])))?.status).toBe('partial');
    }
  });
  it.each([['error', 'error'], ['partial', 'partial'], ['unfinished', 'unverified']])(
    'blank prose does not overwrite %s', (outcome, expected) => {
      const d = domainOutcome('network', '', [receipt('a', outcome)]);
      expect(d.status).toBe(expected);
      expect(normalizeEvidence(answerEvidence([d]))?.domains[0].status).toBe(expected);
    });
  it.each([null, 'PRIVATE', { unknown: 'unknown' }, { truncation: { nodes: 'true' } },
    { partial: null }, { collection: null }, { futureQuality: true }, { unsupported: true }])(
    'present unassessed quality taints a terminal success: %j', quality => {
      const r = normalizeReceipt({ ...receipt('a'), quality });
      expect(r?.outcome).toBe('partial');
      expect(normalizeReceipt(r)).toEqual(r);
      expect(JSON.stringify(r)).not.toContain('PRIVATE');
    });
  it.each(['missing', 'mismatch', 'unsupported', 'valid', 'runtime-unverified'])('%s completion bounds completeness', mode => {
    const completion = mode === 'missing' ? undefined : { version: mode === 'unsupported' ? 2 : 1, receiptCount: mode === 'mismatch' ? 2 : 1 };
    const d = domainOutcome('network', 'answer', [receipt('a')], false, false, completion as any, mode === 'runtime-unverified');
    expect(d.status).toBe(mode === 'valid' ? 'success' : mode === 'runtime-unverified' ? 'unverified' : 'partial');
    expect(normalizeEvidence(answerEvidence([d]))?.status).toBe(d.status);
  });
  it.each(['omitted', 'invalid-domain', 'explicit-unverified'])('normalization remains conservative after %s', mode => {
    const d = { gateway: 'network', status: 'success', receipts: [receipt('a')], completion: { version: 1, receiptCount: 1 } };
    const raw = { version: 1, status: mode === 'explicit-unverified' ? 'unverified' : 'success', domains:
      mode === 'omitted' ? [d, { ...d, gateway: 'data' }, { ...d, gateway: 'ops' }, { ...d, gateway: 'security' }]
      : mode === 'invalid-domain' ? [d, { gateway: 'invalid gateway', status: 'error', receipts: [] }]
      : [{ ...d, status: 'unverified' }] };
    const once = normalizeEvidence(raw);
    expect(once?.status).toBe(mode === 'explicit-unverified' ? 'unverified' : 'partial');
    expect(normalizeEvidence(once)).toEqual(once);
    expect(normalizeEvidence(normalizeEvidence(once))).toEqual(once);
  });
});


it('retains explicit unverified status even for old receipt sets without completion', () => {
  const raw = { version: 1, status: 'unverified', domains: [{ gateway: 'network', status: 'unverified', receipts: [receipt('a')] }] };
  expect(normalizeEvidence(raw)?.status).toBe('unverified');
  expect(normalizeEvidence(raw)?.domains[0].status).toBe('unverified');
});
it.each([{ unknown: 'unknown', invalid: false }, { futureQuality: true, unsupported: false },
  { partial: 'unknown', invalid: false }])('caller flags cannot clear newly detected quality taint: %j', quality => {
  const r = normalizeReceipt({ ...receipt('a'), quality });
  expect(r?.outcome).toBe('partial');
  expect(normalizeReceipt(r)).toEqual(r);
});
it('legacy blank text without receipts remains unverified', () => {
  expect(domainOutcome('network', '').status).toBe('unverified');
});

it.each(['answer', 'domain'])('malformed omission markers cannot certify the %s', level => {
  const d = { gateway: 'network', status: 'success', receipts: [receipt('a')], completion: { version: 1, receiptCount: 1 } };
  const raw = { version: 1, status: 'success', domains: [{ ...d, ...(level === 'domain' ? { truncated: 'true' } : {}) }],
    ...(level === 'answer' ? { truncated: 'true' } : {}) };
  const once = normalizeEvidence(raw);
  expect(once?.status).toBe('partial');
  expect(normalizeEvidence(once)).toEqual(once);
});
it('unknown nested quality fields cannot silently become trustworthy absence', () => {
  expect(normalizeReceipt({ ...receipt('a'), quality: { truncation: { futureLimit: true } } })?.outcome).toBe('partial');
});
