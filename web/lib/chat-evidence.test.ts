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
    const domain = domainOutcome('network', 'answer', (states as string[]).map((s, i) => receipt(`call-${i}`, s)));
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
