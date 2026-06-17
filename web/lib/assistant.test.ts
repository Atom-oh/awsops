import { describe, it, expect, vi } from 'vitest';
import { isProductHelpIntent, assistantAnswer, buildAssistantUser, type AssistantSend } from './assistant';

describe('isProductHelpIntent', () => {
  it('matches AWSops product/how-to questions', () => {
    expect(isProductHelpIntent('prometheus용 분석 agent를 만들려는데 필요한 skill을 설계해줘 /customization')).toBe(true);
    expect(isProductHelpIntent('커스텀 에이전트 어떻게 만들어?')).toBe(true);
    expect(isProductHelpIntent('how do I create a custom agent?')).toBe(true);
    expect(isProductHelpIntent('datasource 등록은 어디서 해?')).toBe(true);
    expect(isProductHelpIntent('agent space 설정 방법')).toBe(true);
    expect(isProductHelpIntent('skill 작성하는 법')).toBe(true);
  });
  it('does NOT steal real AWS-domain questions', () => {
    expect(isProductHelpIntent('내 VPC 통신이 왜 안 되지?')).toBe(false);
    expect(isProductHelpIntent('이번 달 비용 추세 보여줘')).toBe(false);
    expect(isProductHelpIntent('show me 5xx rate for the last hour')).toBe(false);
    expect(isProductHelpIntent('이 IAM 역할 권한 점검')).toBe(false);
  });
});

describe('assistantAnswer', () => {
  it('grounds the answer in the KB (system carries the docs; user is tagged)', async () => {
    let seenSystem = ''; let seenUser = '';
    const send: AssistantSend = async (system, user) => { seenSystem = system; seenUser = user; return '단계: 1) Integration 등록 ...'; };
    const out = await assistantAnswer('prometheus 분석 agent 만들기', { send });
    expect(out).toContain('Integration');
    expect(seenSystem).toContain('<awsops_docs>');
    expect(seenSystem).toContain('/customization');       // KB content present
    expect(seenUser).toBe(buildAssistantUser('prometheus 분석 agent 만들기'));
  });
  it('falls back to a deterministic guide when the model errors (never throws)', async () => {
    const send: AssistantSend = async () => { throw new Error('access denied'); };
    const out = await assistantAnswer('q', { send });
    expect(out).toContain('Customization');
    expect(out).toContain('Integrations');
  });
  it('falls back on empty model output', async () => {
    const send: AssistantSend = async () => '   ';
    const out = await assistantAnswer('q', { send });
    expect(out).toContain('Customization');
  });
});
