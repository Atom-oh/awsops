import { describe, it, expect, vi } from 'vitest';
import { pickGateway, classifyRoute, matchedSections, ACTIVE_FALLBACK } from './route';

describe('pickGateway', () => {
  it('honors an explicit pin over keywords', () => {
    expect(pickGateway('이번 달 비용 알려줘', 'security')).toBe('security');
  });
  it('routes cost keywords', () => {
    expect(pickGateway('이번 달 비용 추세')).toBe('cost');
    expect(pickGateway('show me the billing forecast')).toBe('cost');
  });
  it('routes security keywords', () => {
    expect(pickGateway('이 IAM 역할 권한 점검')).toBe('security');
    expect(pickGateway('why is this action denied by policy')).toBe('security');
  });
  it('routes network keywords', () => {
    expect(pickGateway('두 인스턴스 통신이 안 돼요')).toBe('network');
    expect(pickGateway('check the security group ports')).toBe('network');
  });
  it('falls back to ops for unknown prompts', () => {
    expect(pickGateway('안녕하세요')).toBe('ops');
  });
  it('ignores a pin that is not a known section', () => {
    expect(pickGateway('이번 달 비용', 'bogus')).toBe('cost');
  });
});

describe('matchedSections', () => {
  it('returns distinct matched section keys', () => {
    // 'cost' has two RULES entries — must count as ONE distinct section
    expect(matchedSections('비용이 $100 늘었어')).toEqual(['cost']);
  });
  it('returns multiple keys for a cross-domain prompt', () => {
    const keys = matchedSections('EKS 파드가 RDS에 연결이 안 돼요');
    expect(keys).toContain('network'); // 연결
    expect(keys).toContain('container'); // EKS, 파드
    expect(keys).toContain('data'); // RDS
  });
  it('returns [] when nothing matches', () => {
    expect(matchedSections('안녕하세요')).toEqual([]);
  });
});

describe('ACTIVE_FALLBACK', () => {
  it('is an active section (never inactive ops)', () => {
    expect(ACTIVE_FALLBACK).toBe('network'); // first active section in SECTIONS order
  });
});

describe('classifyRoute', () => {
  it('pin wins and skips the classifier', async () => {
    const classify = vi.fn();
    const r = await classifyRoute('이번 달 비용', 'security', { llmEnabled: true, classify });
    expect(r).toEqual({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'pin', multiDomain: false, selected: [{ key: 'security', score: 1, active: true }] });
    expect(classify).not.toHaveBeenCalled();
  });
  it('single distinct regex match short-circuits (no LLM call)', async () => {
    const classify = vi.fn();
    const r = await classifyRoute('show me the billing forecast', undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('cost');
    expect(r.method).toBe('regex');
    expect(classify).not.toHaveBeenCalled();
  });
  it('multi-match goes to the LLM and returns top-3 with active flags', async () => {
    const classify = vi.fn().mockResolvedValue([
      { key: 'network', score: 0.9 }, { key: 'data', score: 0.6 }, { key: 'container', score: 0.4 },
    ]);
    const r = await classifyRoute('EKS 파드가 RDS에 연결이 안 돼요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('llm');
    expect(r.primary).toBe('network');
    expect(r.ranked).toEqual([
      { key: 'network', score: 0.9, active: true },
      { key: 'data', score: 0.6, active: true }, // data activated in Wave-1
      { key: 'container', score: 0.4, active: false },
    ]);
  });
  it('no-match goes to the LLM too', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'ops', score: 0.7 }]);
    const r = await classifyRoute('어제부터 뭔가 이상해요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('llm');
    expect(r.primary).toBe('ops');
  });
  it('LLM empty result falls back to first-match regex when one exists', async () => {
    const classify = vi.fn().mockResolvedValue([]);
    const r = await classifyRoute('EKS 파드가 RDS에 연결이 안 돼요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('regex'); // first-match (network — RULES order) still beats a dead LLM
    expect(r.primary).toBe('network');
  });
  it('LLM failure + no regex match falls back to ACTIVE_FALLBACK (never inactive ops)', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('bedrock down'));
    const r = await classifyRoute('안녕하세요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('fallback');
    expect(r.primary).toBe(ACTIVE_FALLBACK);
  });
  it('llmEnabled=false keeps legacy first-match behavior (ops fallback allowed)', async () => {
    const r = await classifyRoute('안녕하세요', undefined, { llmEnabled: false });
    expect(r.primary).toBe('ops'); // legacy pickGateway behavior preserved when flag off
    expect(r.method).toBe('regex');
  });
  it('honors a pin to a valid-but-inactive section, surfacing active:false (spec §2.3)', async () => {
    // 'container' is still inactive after the Wave-1 fleet activation (data/cost/monitoring went active)
    const r = await classifyRoute('아무거나', 'container', { llmEnabled: true, classify: vi.fn() });
    expect(r).toEqual({ primary: 'container', ranked: [{ key: 'container', score: 1, active: false }], method: 'pin', multiDomain: false, selected: [{ key: 'container', score: 1, active: false }] });
  });
  it('marks an unknown key from a custom classifier as active:false (contract)', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'bogus-section', score: 0.9 }]);
    const r = await classifyRoute('어제부터 뭔가 이상해요', undefined, { llmEnabled: true, classify });
    // production classifyPrompt is enum-validated so this can't happen in the wired path;
    // this documents the policy-layer contract for any future custom classify injection.
    expect(r.method).toBe('llm');
    expect(r.ranked[0]).toEqual({ key: 'bogus-section', score: 0.9, active: false });
  });
});

describe('classifyRoute — ADR-044 multi-domain detection', () => {
  it('≥2 active routes above threshold ⇒ multiDomain + selected (desc, ≤3)', async () => {
    const classify = vi.fn().mockResolvedValue([
      { key: 'network', score: 0.9 }, { key: 'data', score: 0.6 }, { key: 'container', score: 0.5 },
    ]);
    const r = await classifyRoute('EKS 파드가 RDS에 연결이 안 돼요', undefined, { llmEnabled: true, classify });
    expect(r.multiDomain).toBe(true);
    // container is inactive ⇒ excluded from the fan-out set even though score ≥ threshold
    expect(r.selected.map((s) => s.key)).toEqual(['network', 'data']);
  });
  it('one dominant active route ⇒ single (multiDomain false, selected=[primary])', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'cost', score: 0.95 }, { key: 'data', score: 0.1 }]);
    const r = await classifyRoute('어제부터 뭔가 이상해요', undefined, { llmEnabled: true, classify }); // no regex match ⇒ LLM
    expect(r.method).toBe('llm');
    expect(r.multiDomain).toBe(false);
    expect(r.selected).toEqual([{ key: 'cost', score: 0.95, active: true }]); // data below threshold dropped
  });
  it('below-threshold routes are excluded from the fan-out set', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'network', score: 0.9 }, { key: 'data', score: 0.2 }]);
    const r = await classifyRoute('x', undefined, { llmEnabled: true, classify, minScore: 0.3 });
    expect(r.multiDomain).toBe(false); // only network clears 0.3
    expect(r.selected.map((s) => s.key)).toEqual(['network']);
  });
  it('two active routes both above an explicit minScore ⇒ multiDomain', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'network', score: 0.55 }, { key: 'security', score: 0.45 }]);
    const r = await classifyRoute('x', undefined, { llmEnabled: true, classify, minScore: 0.4 });
    expect(r.multiDomain).toBe(true);
    expect(r.selected.map((s) => s.key)).toEqual(['network', 'security']);
  });
  it('pin and regex paths are never multiDomain', async () => {
    const pin = await classifyRoute('아무거나', 'cost', { llmEnabled: true, classify: vi.fn() });
    expect(pin.multiDomain).toBe(false);
    const rx = await classifyRoute('show me the billing forecast', undefined, { llmEnabled: true, classify: vi.fn() });
    expect(rx.multiDomain).toBe(false);
  });
});
