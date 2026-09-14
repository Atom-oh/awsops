import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/awsops_v2_agent-abcdefghij';
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

/** Mock an SSE (text/event-stream) runtime response. Each frame is a `data: <payload>` line;
 *  `splitAt` lets a test slice the byte stream mid-frame to exercise the line buffer. */
function eventStreamOf(frames: string[], splitAt?: number) {
  const enc = new TextEncoder();
  const bytes = enc.encode(frames.map((f) => `data: ${f}\n\n`).join(''));
  const chunks = splitAt != null ? [bytes.slice(0, splitAt), bytes.slice(splitAt)] : [bytes];
  return {
    contentType: 'text/event-stream',
    response: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const ch of chunks) c.enqueue(ch);
            c.close();
          },
        }),
    },
  };
}

describe('agentcore', () => {
  it('does not return an interrupted answer as success to text-only consumers', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ delta: 'partial' }), JSON.stringify({ runtimeOutcome: 'error' }),
    ]));
    const { invokeAgent } = await import('./agentcore');
    await expect(invokeAgent({ gateway: 'ops', messages: [], sessionId: 's'.repeat(36) })).rejects.toThrow('interrupted');
  });
  it('never turns malformed or oversized receipt frames into saved answer text', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([
      '{"receipt":{"result":"SECRET"',
      JSON.stringify({ receipt: { result: 'SECRET'.repeat(60000) } }),
      JSON.stringify({ delta: 'Useful answer' }),
    ], 100));
    const { invokeAgentDetailed } = await import('./agentcore');
    const answer = await invokeAgentDetailed({ gateway: 'network', messages: [], sessionId: 's'.repeat(36) });
    expect(answer.text).toBe('Useful answer');
    expect(answer.evidenceTruncated).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });
  it('consumes receipts produced by Python from the recorded real Strands public stream', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    const dir = fileURLToPath(new URL('../../agent/', import.meta.url));
    const script = `
import json,sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from test_tool_receipts import collect
events=json.loads((Path(sys.argv[1])/'fixtures/strands-1.41-public-stream.json').read_text())
print(json.dumps(collect(events)))
`;
    const output = execFileSync('python3', ['-B', '-c', script, dir], { encoding: 'utf8' });
    const frames = JSON.parse(output.trim().split('\n').at(-1)!);
    acSend.mockResolvedValue(eventStreamOf(frames.map((frame: unknown) => JSON.stringify(frame))));
    const { invokeAgentDetailed } = await import('./agentcore');
    const answer = await invokeAgentDetailed({ gateway: 'network', messages: [], sessionId: 's'.repeat(36) });
    expect(answer.text).toBe('Synthetic result.');
    // The public SDK fixture proves delivery/correlation, not a recognized producer envelope.
    expect(answer.receipts?.map(r => [r.callId, r.tool, r.outcome])).toEqual([
      ['call-0', 'scoped_read', 'unverified'], ['call-1', 'scoped_read', 'unverified'],
    ]);
    expect(answer.completion).toEqual({ version: 1, receiptCount: 2 });
    const { domainOutcome } = await import('./chat-evidence');
    expect(domainOutcome('network', answer.text, answer.receipts ?? [], !!answer.evidenceTruncated,
      answer.runtimeError, answer.completion, answer.runtimeUnverified).status).toBe('unverified');
    expect(answer.receipts?.every(r => Object.keys(r.observedScope).length === 0)).toBe(true);
  });
  it('cancels a pending runtime read when the caller aborts', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    let cancelled = false;
    acSend.mockResolvedValue({ contentType: 'text/event-stream', response: {
      transformToWebStream: () => new ReadableStream({ cancel: () => { cancelled = true; } }),
    } });
    const { invokeAgentStreamDetailed } = await import('./agentcore');
    const ac = new AbortController();
    const stream = invokeAgentStreamDetailed({ gateway: 'network', messages: [], sessionId: 's'.repeat(36), abortSignal: ac.signal });
    const pending = stream.next();
    await new Promise(resolve => setTimeout(resolve, 0));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
    expect(acSend).toHaveBeenCalledTimes(1);
  });
  it('keeps versioned receipts through SSE and rejects credential-bearing metadata', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ delta: 'answer' }),
      JSON.stringify({ receipt: { version: 1, callId: 'call-1', tool: 'network___inspect',
        observedAt: 1000, terminalObservedAt: 2000, outcome: 'partial',
        requestedScope: { accountId: '123456789012' }, observedScope: {},
        inputs: { region: 'us-east-1', query: 'SECRET', url: 'https://user:SECRET@host' },
        quality: { partial: true, secret: 'SECRET' }, result: 'SECRET',
      } }),
      JSON.stringify({ receipt: { version: 99, callId: 'invalid', result: 'SECRET' } }),
    ], 23));
    const { invokeAgentDetailed } = await import('./agentcore');
    const answer = await invokeAgentDetailed({ gateway: 'network', messages: [], sessionId: 's'.repeat(36) });
    expect(answer.text).toBe('answer');
    expect((answer as any).receipts).toHaveLength(1);
    expect((answer as any).receipts[0]).toMatchObject({
      callId: 'call-1', outcome: 'partial', observedScope: {}, inputs: { region: 'us-east-1' },
    });
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });
  it.each([
    [['list_users'], ['list_roles'], [], ['!awsops-deny-all!']],
    [['list_users'], ['iam-mcp-target___list_users'], ['iam-mcp-target___list_users'], ['iam-mcp-target___list_users']],
  ])('preserves resolved permissions through JSON and old/new Python filtering: %j', async (declared, cap, expected, wire) => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { resolveAgent } = await import('./agent-resolver');
    const { invokeAgent } = await import('./agentcore');
    const spec = resolveAgent('audit-agent', [{
      id: 1, name: 'audit-agent', description: 'd', persona: 'Read only', gateway: 'security',
      tier: 'custom', enabled: true, version: 1, routingKeywords: [],
      skills: [{ name: 'audit-skill', instructions: 'Inspect', contentHash: 'h', ord: 0, toolAllowlist: declared }],
    }], { accountId: 'self', enabledAgentIds: [1], enabledSkillIds: [], toolAllowlist: cap, version: 1 });
    expect(spec.toolAllowlist).toEqual(expected);
    await invokeAgent({ ...spec, messages: [{ role: 'user', content: 'inspect' }], sessionId: 's'.repeat(36) });
    const payload = new TextDecoder().decode(acSend.mock.calls[0][0].input.payload);
    expect(JSON.parse(payload).toolAllowlist).toEqual(wire);
    // Execute only the production pure filter: never import the AWS runtime or contact AWS.
    const script = `
import ast,json,sys
from pathlib import Path
from types import SimpleNamespace
tree=ast.parse(Path(sys.argv[1]).read_text())
node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_filter_tools')
scope={}
exec(compile(ast.Module(body=[node],type_ignores=[]),sys.argv[1],'exec'),scope)
payload=json.load(sys.stdin)
tools=[SimpleNamespace(tool_name=n) for n in ['iam-mcp-target___list_users','iam-mcp-target___list_roles','foreign___list_users']]
allow=payload.get('toolAllowlist')
# Pre-fix runtime semantics: falsy lists mean unrestricted, otherwise exact matching.
legacy=tools if not allow else [t for t in tools if t.tool_name in set(allow)]
print(json.dumps({'current': [t.tool_name for t in scope['_filter_tools'](tools,allow)],
                  'legacy': [t.tool_name for t in legacy]}))
`;
    const filtered = execFileSync('python3', ['-B', '-c', script, fileURLToPath(new URL('../../agent/agent.py', import.meta.url))], { input: payload, encoding: 'utf8' });
    expect(JSON.parse(filtered)).toEqual({ current: expected, legacy: expected });
  });
  it('explicit empty disables discovery and absence retains the legacy parameter path', async () => {
    vi.resetModules();
    process.env.SSM_RUNTIME_ARN_PARAM = '';
    const disabled = await import('./agentcore');
    await expect(disabled.getRuntimeArn()).rejects.toThrow('disabled');
    expect(ssmSend).not.toHaveBeenCalled();
    vi.resetModules();
    delete process.env.SSM_RUNTIME_ARN_PARAM;
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    const legacy = await import('./agentcore');
    await legacy.getRuntimeArn();
    expect(ssmSend.mock.calls[0][0].input.Name).toBe('/ops/awsops-v2/agentcore/runtime_arn');
  });
  it.each(['PENDING', 'arn:rt', RUNTIME_ARN.replace('awsops_v2_agent', 'foreign')])(
    'never caches invalid discovery values: %s', async value => {
      vi.resetModules();
      ssmSend.mockResolvedValueOnce({ Parameter: { Value: value } })
        .mockResolvedValueOnce({ Parameter: { Value: RUNTIME_ARN } });
      const { getRuntimeArn } = await import('./agentcore');
      await expect(getRuntimeArn()).rejects.toThrow('invalid');
      expect(await getRuntimeArn()).toBe(RUNTIME_ARN);
      expect(ssmSend).toHaveBeenCalledTimes(2);
    });
  it('caches the runtime ARN (SSM hit once)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    const { getRuntimeArn } = await import('./agentcore');
    expect(await getRuntimeArn()).toBe(RUNTIME_ARN);
    expect(await getRuntimeArn()).toBe(RUNTIME_ARN);
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });
  it('invokes and returns the agent text', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('이번 달 비용은 $4,210입니다')) });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    expect(text).toContain('$4,210');
  });
  it('retries once on transient failure', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockRejectedValueOnce(new Error('throttle')).mockResolvedValueOnce({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) });
    expect(text).toBe('ok');
    expect(acSend).toHaveBeenCalledTimes(2);
  });
  it('includes systemPromptOverride + traceability in the payload when present', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
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
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    await invokeAgent({
      gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36),
      accountId: '123456789012', accountAlias: 'prod',
    });
    const withAcct = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect(withAcct.accountId).toBe('123456789012');
    expect(withAcct.accountAlias).toBe('prod');

    acSend.mockClear();
    await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    const without = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect('accountId' in without).toBe(false);
    expect('accountAlias' in without).toBe(false);
  });

  it('ADR-039: threads integrations into the payload when non-empty, omits otherwise', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
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

  // --- real streaming (SSE) ---
  it('invokeAgentStream yields SSE deltas incrementally', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ delta: '이번 ' }), JSON.stringify({ delta: '달 비용은 ' }), JSON.stringify({ delta: '$4,210' }),
    ]));
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out).toEqual(['이번 ', '달 비용은 ', '$4,210']);
  });

  it('invokeAgent collects SSE deltas into the full answer (buffered consumer)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ delta: 'a' }), JSON.stringify({ delta: 'b' }), JSON.stringify({ delta: 'c' }),
    ]));
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    expect(text).toBe('abc');
  });

  it('buffers SSE frames split across stream chunks', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    // split mid-frame so a `data:` line spans two reads → exercises the line buffer
    acSend.mockResolvedValue(eventStreamOf([JSON.stringify({ delta: 'hello ' }), JSON.stringify({ delta: 'world' })], 9));
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out.join('')).toBe('hello world');
  });

  it('tolerates a raw Strands event shape ({data}) and skips non-text frames', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ data: 'hi' }),                 // raw strands event → text
      JSON.stringify({ current_tool_use: { name: 'x' } }), // non-text event → skipped
      JSON.stringify({ delta: ' there' }),
    ]));
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out.join('')).toBe('hi there');
  });

  it('cancels the upstream reader when the consumer stops early (client abort)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    let cancelled = false;
    const enc = new TextEncoder();
    const frames = [JSON.stringify({ delta: 'a' }), JSON.stringify({ delta: 'b' }), JSON.stringify({ delta: 'c' })];
    acSend.mockResolvedValue({
      contentType: 'text/event-stream',
      response: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const f of frames) c.enqueue(enc.encode(`data: ${f}\n\n`));
              c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
      },
    });
    const { invokeAgentStream } = await import('./agentcore');
    for await (const _d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) {
      break; // stop after the first delta → streamDeltas' finally must cancel the upstream body
    }
    expect(cancelled).toBe(true);
  });

  it('backward-compat: a legacy buffered JSON answer streams as one delta', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('legacy answer')) }); // no contentType
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out).toEqual(['legacy answer']);
  });

  // --- real streaming + provenance (invokeAgentStreamDetailed) ---
  it('invokeAgentStreamDetailed yields delta/tool/model events live, in arrival order', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ model: 'sonnet-4-6' }),
      JSON.stringify({ delta: '이번 ' }),
      JSON.stringify({ tool: 'get_cost' }),
      JSON.stringify({ delta: '달 비용은 $4,210' }),
    ]));
    const { invokeAgentStreamDetailed } = await import('./agentcore');
    const events: unknown[] = [];
    for await (const ev of invokeAgentStreamDetailed({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) })) events.push(ev);
    expect(events).toEqual([
      { model: 'sonnet-4-6' },
      { delta: '이번 ' },
      { tool: 'get_cost' },
      { delta: '달 비용은 $4,210' },
    ]);
  });

  it('invokeAgentStreamDetailed keeps frame boundaries intact when split mid-frame', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf([JSON.stringify({ delta: 'hello ' }), JSON.stringify({ delta: 'world' })], 9));
    const { invokeAgentStreamDetailed } = await import('./agentcore');
    const deltas: string[] = [];
    for await (const ev of invokeAgentStreamDetailed({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) {
      if (ev.delta) deltas.push(ev.delta);
    }
    // Two distinct events, not one coalesced string — a mid-byte split must not merge the frames.
    expect(deltas).toEqual(['hello ', 'world']);
  });

  it('invokeAgentStreamDetailed backward-compat: a legacy buffered JSON answer yields one delta event', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('legacy answer')) }); // no contentType
    const { invokeAgentStreamDetailed } = await import('./agentcore');
    const events: unknown[] = [];
    for await (const ev of invokeAgentStreamDetailed({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) events.push(ev);
    expect(events).toEqual([{ delta: 'legacy answer' }]);
  });
});

describe('review public-stream receipt contract', () => {
  const dir = fileURLToPath(new URL('../../agent/', import.meta.url));
  const script = `
import json,sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from test_tool_receipts import collect,use,result
cases=json.loads((Path(sys.argv[1])/'fixtures/task4-receipt-cases.json').read_text())
for case in cases:
    start=use('a')
    start['message']['content'][0]['toolUse']['name']=case.get('tool','network___inspect')
    end=result('a',{})
    end['message']['content'][0]['toolResult']['content']=case['content']
    case['frames']=collect([start,end,{'data':'answer'}])
print(json.dumps(cases))
`;
  // This executes only the offline public-message adapter; test_agent stubs AWS/Strands clients.
  const cases = JSON.parse(execFileSync('python3', ['-B', '-c', script, dir], { encoding: 'utf8' }).trim().split('\n').at(-1)!);
  it.each(cases)('$name survives Python production, SSE and restoration', async ({ frames, outcome, marker, expectedSourceId, expectedWindow }) => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
    acSend.mockResolvedValue(eventStreamOf(frames.map((f: unknown) => JSON.stringify(f)), 73));
    const { invokeAgentDetailed } = await import('./agentcore');
    const { domainOutcome, answerEvidence, normalizeEvidence } = await import('./chat-evidence');
    const a = await invokeAgentDetailed({ gateway: 'network', messages: [], sessionId: 's'.repeat(36) });
    const d = domainOutcome('network', a.text, a.receipts, a.evidenceTruncated, a.runtimeError, a.completion, a.runtimeUnverified);
    expect(a.receipts?.[0].outcome).toBe(outcome);
    if (marker) expect(a.receipts?.[0].quality?.[marker]).toBe(true);
    expect(d.status).toBe(outcome);
    const restored = normalizeEvidence(normalizeEvidence(answerEvidence([d])));
    expect(restored?.status).toBe(outcome);
    if (expectedSourceId) expect(restored?.domains[0].receipts[0].quality?.collection).toMatchObject({
      windowStartMs: expectedWindow[0], windowEndMs: expectedWindow[1],
      sources: [{ sourceId: expectedSourceId, windowStartMs: expectedWindow[0], windowEndMs: expectedWindow[1] }],
    });
    expect(JSON.stringify(a)).not.toContain('PRIVATE');
  });
  it.each(['short-tail', 'missing-completion', 'mismatch', 'unsupported', 'late-receipt', 'runtime-unverified', 'complete'])(
    '%s with repeated names cannot conceal a withheld failure', async mode => {
      vi.resetModules();
      ssmSend.mockResolvedValue({ Parameter: { Value: RUNTIME_ARN } });
      const receipt = { version: 1, callId: 'a', tool: 'inspect', observedAt: 1000, terminalObservedAt: 2000,
        outcome: 'success', inputs: {}, requestedScope: {}, observedScope: {} };
      const frames: unknown[] = [{ tool: 'inspect' }, { tool: 'inspect' }, { delta: 'answer' }, { receipt }];
      if (!['short-tail', 'late-receipt'].includes(mode)) frames.push({ receipt: { ...receipt, callId: 'b', outcome: mode === 'complete' ? 'error' : 'success' } });
      if (!['short-tail', 'missing-completion'].includes(mode)) frames.push({ completion: {
        version: mode === 'unsupported' ? 2 : 1, receiptCount: mode === 'mismatch' ? 3 : mode === 'late-receipt' ? 1 : 2 } });
      if (mode === 'late-receipt') frames.push({ receipt: { ...receipt, callId: 'b' } });
      if (mode === 'runtime-unverified') frames.push({ runtimeOutcome: 'unverified' });
      acSend.mockResolvedValue(eventStreamOf(frames.map(f => JSON.stringify(f))));
      const { invokeAgentDetailed } = await import('./agentcore');
      const { domainOutcome } = await import('./chat-evidence');
      const a = await invokeAgentDetailed({ gateway: 'network', messages: [], sessionId: 's'.repeat(36) });
      const d = domainOutcome('network', a.text, a.receipts, a.evidenceTruncated, a.runtimeError, a.completion, a.runtimeUnverified);
      expect(d.status).toBe(mode === 'runtime-unverified' ? 'unverified' : 'partial');
      expect(a.text).toBe('answer');
    });
});
