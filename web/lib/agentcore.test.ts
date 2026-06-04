import { describe, it, expect, vi, beforeEach } from 'vitest';

const ssmSend = vi.fn();
const acSend = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssmSend; },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class { send = acSend; },
  InvokeAgentRuntimeCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => {
  ssmSend.mockReset();
  acSend.mockReset();
  process.env.SSM_RUNTIME_ARN_PARAM = '/ops/awsops-v2/agentcore/runtime_arn';
});

function streamOf(s: string) {
  return { transformToString: async () => s };
}

describe('agentcore', () => {
  it('caches the runtime ARN (SSM hit once)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    const { getRuntimeArn } = await import('./agentcore');
    expect(await getRuntimeArn()).toBe('arn:rt');
    expect(await getRuntimeArn()).toBe('arn:rt');
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });
  it('invokes and returns the agent text', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('이번 달 비용은 $4,210입니다')) });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    expect(text).toContain('$4,210');
  });
  it('retries once on transient failure', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockRejectedValueOnce(new Error('throttle')).mockResolvedValueOnce({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) });
    expect(text).toBe('ok');
    expect(acSend).toHaveBeenCalledTimes(2);
  });
});
