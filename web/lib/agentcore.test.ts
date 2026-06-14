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
  it('includes systemPromptOverride + traceability in the payload when present', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    await invokeAgent({
      gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36),
      systemPromptOverride: 'OVERRIDE', toolAllowlist: ['t1'], agentName: 'compliance', agentVersion: 3, skillHashes: ['h1'],
    });
    const cmd = acSend.mock.calls[0][0] as { input: { payload: Uint8Array } };
    const sent = JSON.parse(new TextDecoder().decode(cmd.input.payload));
    expect(sent.systemPromptOverride).toBe('OVERRIDE');
    expect(sent.toolAllowlist).toEqual(['t1']);
    expect(sent.agentName).toBe('compliance');
    expect(sent.agentVersion).toBe(3);
    expect(sent.skillHashes).toEqual(['h1']);
  });
  it('threads accountId + accountAlias into the payload when present, omits them otherwise', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    await invokeAgent({
      gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36),
      accountId: '180294183052', accountAlias: 'prod',
    });
    const withAcct = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect(withAcct.accountId).toBe('180294183052');
    expect(withAcct.accountAlias).toBe('prod');

    acSend.mockClear();
    await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    const without = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect('accountId' in without).toBe(false);
    expect('accountAlias' in without).toBe(false);
  });

  it('ADR-039: threads integrations into the payload when non-empty, omits otherwise', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    const integrations = [{ name: 'dd', endpoint: 'https://x/mcp', transport: 'api_key', credentialsRef: 'arn:sec', exposedTools: ['datadog_query'], allowPrivate: false }];
    await invokeAgent({ gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36), integrations });
    const withI = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect(withI.integrations).toEqual(integrations);

    acSend.mockClear();
    await invokeAgent({ gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36), integrations: [] });
    const empty = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect('integrations' in empty).toBe(false);

    acSend.mockClear();
    await invokeAgent({ gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    const none = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect('integrations' in none).toBe(false);
  });
});
