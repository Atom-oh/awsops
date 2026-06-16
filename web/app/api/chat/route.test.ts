import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const verifyUser = vi.fn();
const invokeAgent = vi.fn();
const pickGateway = vi.fn();
const getEnabledCustomAgents = vi.fn();
const pickCustomAgent = vi.fn();
const resolveAgent = vi.fn();
const isCustomAgentEnabled = vi.fn();
const recordCustomAgentTrace = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/agentcore', () => ({ invokeAgent: (...a: unknown[]) => invokeAgent(...a) }));
const classifyRoute = vi.fn();
vi.mock('@/lib/route', () => ({
  pickGateway: (...a: unknown[]) => pickGateway(...a),
  classifyRoute: (...a: unknown[]) => classifyRoute(...a),
}));
const classifyPrompt = vi.fn();
vi.mock('@/lib/classifier', () => ({ classifyPrompt: (...a: unknown[]) => classifyPrompt(...a) }));
vi.mock('@/lib/catalog-source', () => ({ getEnabledCustomAgents: (...a: unknown[]) => getEnabledCustomAgents(...a) }));
vi.mock('@/lib/agent-resolver', () => ({
  pickCustomAgent: (...a: unknown[]) => pickCustomAgent(...a),
  resolveAgent: (...a: unknown[]) => resolveAgent(...a),
}));
vi.mock('@/lib/catalog', () => ({ isCustomAgentEnabled: (...a: unknown[]) => isCustomAgentEnabled(...a) }));
const getEnabledIntegrations = vi.fn();
vi.mock('@/lib/integrations', () => ({ getEnabledIntegrations: (...a: unknown[]) => getEnabledIntegrations(...a) }));
vi.mock('@/lib/trace', () => ({ recordCustomAgentTrace: (...a: unknown[]) => recordCustomAgentTrace(...a) }));
const recordExchange = vi.fn();
vi.mock('@/lib/chat-store', () => ({ recordExchange: (...a: unknown[]) => recordExchange(...a) }));
const synthesizeStream = vi.fn();
vi.mock('@/lib/synthesize', () => ({ synthesizeStream: (...a: unknown[]) => synthesizeStream(...a) }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}
async function readStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

beforeEach(() => {
  verifyUser.mockReset();
  invokeAgent.mockReset();
  pickGateway.mockReset();
  getEnabledCustomAgents.mockReset();
  pickCustomAgent.mockReset();
  resolveAgent.mockReset();
  isCustomAgentEnabled.mockReset();
  getEnabledIntegrations.mockReset();
  recordCustomAgentTrace.mockReset();
  // default to the built-in no-op shape
  getEnabledCustomAgents.mockResolvedValue([]);
  pickCustomAgent.mockReturnValue(null);
  isCustomAgentEnabled.mockResolvedValue(true); // ADR-039: authoritative re-check passes by default
  getEnabledIntegrations.mockResolvedValue([]); // ADR-039 P2: no integrations by default

  resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
  classifyRoute.mockReset();
  classifyRoute.mockResolvedValue({ primary: 'ops', ranked: [{ key: 'ops', score: 0, active: false }], method: 'regex' });
  classifyPrompt.mockReset();
  recordExchange.mockReset();
  recordExchange.mockResolvedValue(undefined);
  synthesizeStream.mockReset();
  // default: real-shaped async-generator returning a deterministic merged answer
  synthesizeStream.mockImplementation(async function* () { yield '합성된 답변'; });
  delete process.env.HYBRID_ROUTING_ENABLED;
  delete process.env.MULTI_ROUTE_SYNTHESIS_ENABLED;
});

afterEach(() => { delete process.env.HYBRID_ROUTING_ENABLED; delete process.env.MULTI_ROUTE_SYNTHESIS_ENABLED; });

describe('POST /api/chat', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'hi', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(401);
  });
  it('413 on oversize prompt', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'x'.repeat(60000), sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(413);
  });
  it('streams a typewriter SSE on the happy path + passes the gateway', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
    invokeAgent.mockResolvedValue('비용은 $10 입니다');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '비용', section: 'cost', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await readStream(res);
    expect(body).toContain('"gateway":"cost"');
    expect(body).toContain('비용은');
    expect(body).toContain('[DONE]');
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'cost' }));
  });
  it('emits an error frame when invoke fails', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    invokeAgent.mockRejectedValue(new Error('boom'));
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'x', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(body).toContain('"error"');
  });
  it('resolves a custom agent and forwards systemPromptOverride', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: ['cis'], skills: [] }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', agentVersion: 2, skillHashes: ['h1'] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'cis check', section: 'security', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(200);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ systemPromptOverride: 'OVR', agentName: 'compliance' }));
    const body = await readStream(res);
    expect(body).toContain('"agentName":"compliance"');
  });
});

describe('hybrid routing (ADR-038)', () => {
  it('flag off: uses legacy pickGateway path, no classifyRoute call', async () => {
    delete process.env.HYBRID_ROUTING_ENABLED;
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '이번 달 비용', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(pickGateway).toHaveBeenCalled();
    expect(classifyRoute).not.toHaveBeenCalled();
    expect(body).toContain('"gateway":"cost"');
  });

  it('flag on: classifyRoute decides, meta carries ranked+method', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'network',
      ranked: [
        { key: 'network', score: 0.9, active: true },
        { key: 'data', score: 0.5, active: false },
      ],
      method: 'llm',
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'EKS 파드가 RDS 연결 안돼', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(body).toContain('"method":"llm"');
    expect(body).toContain('"ranked":[{"key":"network"');
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'network' }));
  });

  it('flag on: inactive top-1 short-circuits — no agent call, guidance message, meta still emitted', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'container',
      ranked: [{ key: 'container', score: 0.9, active: false }, { key: 'network', score: 0.4, active: true }],
      method: 'llm',
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '파드 CrashLoop 원인', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(body).toContain('"method":"llm"'); // meta ALWAYS emitted (spec §6)
    expect(body).toContain('P3'); // guidance delta mentions availability
    expect(body).toContain('[DONE]');
  });

  it('flag on: explicit pin beats custom agent (spec §2.2 precedence)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'pin' });
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance' }]);
    pickCustomAgent.mockReturnValue('compliance'); // custom WOULD match...
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'run a CIS benchmark', section: 'security', sessionId: 's'.repeat(36) }));
    await readStream(res);
    // ...but the pin wins: resolveAgent called with the pinned section, not the custom name.
    // Phase 2: third arg is the per-account space (null here — no AURORA_ENDPOINT ⇒ Phase-1).
    expect(resolveAgent).toHaveBeenCalledWith('security', expect.anything(), null, [], []);
  });

  it('logs a structured misroute candidate when the client reports a chip switch (spec §5)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'pin' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', section: 'security', switchedFrom: 'network', sessionId: 's'.repeat(36) })));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"misroute"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"from":"network"'));
    warn.mockRestore();
  });

  it('flag on: without a pin, custom agent still beats the classifier', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'regex' });
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance' }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', agentName: 'compliance', skillHashes: ['h'] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'run a CIS benchmark', sessionId: 's'.repeat(36) }));
    await readStream(res);
    expect(resolveAgent).toHaveBeenCalledWith('compliance', expect.anything(), null, [], []);
  });

  it('fail-closed revocation: a disabled custom agent is NOT used — falls back to the gateway', async () => {
    delete process.env.HYBRID_ROUTING_ENABLED;            // hybrid off → gateway = pickGateway
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance' }]); // 30s-stale cache still lists it
    pickCustomAgent.mockReturnValue('compliance');
    isCustomAgentEnabled.mockResolvedValue(false);        // authoritative Aurora check: revoked
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'run a CIS benchmark', sessionId: 's'.repeat(36) })));
    expect(isCustomAgentEnabled).toHaveBeenCalledWith('compliance');
    expect(resolveAgent).toHaveBeenCalledWith('security', expect.anything(), null, [], []); // gateway, not the revoked custom
  });

  it('ADR-039: passes ONLY enabled egress-READ integrations to resolveAgent, WITH connection details (ingress + READ_WRITE excluded)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'ops', ranked: [{ key: 'ops', score: 1, active: true }], method: 'regex' });
    getEnabledIntegrations.mockResolvedValue([
      { name: 'dd', direction: 'egress', capability: 'read', exposedTools: ['datadog_query'], providedContext: { d: 1 },
        endpoint: 'https://mcp.dd/mcp', transport: 'api_key', credentialsRef: 'arn:dd' },
      { name: 'notion', direction: 'egress', capability: 'read_write', exposedTools: ['notion_write'], providedContext: {}, writeActionRefs: ['notion.create_page'] }, // write → propose-only (5th arg), NOT tool-injected (4th)
      { name: 'pd', direction: 'ingress', capability: 'read', exposedTools: [], providedContext: {} },                       // ingress → excluded
    ]);
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    // 4th arg = ONLY the egress+read integration (with connection details + allowPrivate=false);
    // 5th arg = the READ_WRITE integration as PROPOSE-ONLY (never tool-injected). ADR-040/041.
    expect(resolveAgent).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), null,
      [{ name: 'dd', exposedTools: ['datadog_query'], providedContext: { d: 1 },
         endpoint: 'https://mcp.dd/mcp', transport: 'api_key', credentialsRef: 'arn:dd', allowPrivate: false }],
      [{ name: 'notion', writeActionRefs: ['notion.create_page'] }],
    );
  });

  it('ADR-039 P2-infra inc2: forwards spec.integrations to invokeAgent', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    const integrations = [{ name: 'dd', endpoint: 'https://mcp.dd/mcp', transport: 'api_key', credentialsRef: 'arn:dd', exposedTools: ['datadog_query'], allowPrivate: false }];
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', agentName: 'sec-custom', skillHashes: [], systemPromptOverride: 'X', toolAllowlist: ['datadog_query'], integrations });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ integrations }));
  });
});

describe('thread persistence', () => {
  it('emits threadId in meta and records the exchange after a successful invoke', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '질문', sessionId: 's'.repeat(36) })));
    expect(body).toContain('"threadId":"');
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({
      userSub: 'u1', userContent: '질문', assistantContent: 'answer', gateway: 'security',
    }));
  });

  it('reuses a provided threadId', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const tid = '123e4567-e89b-42d3-a456-426614174000';
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', threadId: tid, sessionId: 's'.repeat(36) })));
    expect(body).toContain(`"threadId":"${tid}"`);
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({ threadId: tid }));
  });

  it('does not record when the agent invoke fails, and chat still streams the error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockRejectedValue(new Error('boom'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(body).toContain('[DONE]');
    expect(recordExchange).not.toHaveBeenCalled();
  });

  it('records the inactive-section guidance exchange too (spec §3)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u1' });
    classifyRoute.mockResolvedValue({ primary: 'container', ranked: [{ key: 'container', score: 0.9, active: false }], method: 'llm' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: '파드 CrashLoop 원인', sessionId: 's'.repeat(36) })));
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({
      userContent: '파드 CrashLoop 원인',
      assistantContent: expect.stringContaining('P3'),
    }));
  });

  it('a rejecting recordExchange does not break the SSE stream (defensive)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    recordExchange.mockRejectedValue(new Error('store blew up'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(body).toContain('answer');
    expect(body).toContain('[DONE]');
  });
});

describe('ADR-031 Phase 2 — per-account space wiring', () => {
  it('resolves the account and threads accountId into the custom-agent loader, resolver, and invoke', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'status', sessionId: 's'.repeat(36) })));
    // account resolves to the single-account default ('self') with no HOST_ACCOUNT_ID set.
    expect(getEnabledCustomAgents).toHaveBeenCalledWith('self');
    // no AURORA_ENDPOINT ⇒ getAgentSpace returns null ⇒ resolver gets null (Phase-1 behavior).
    expect(resolveAgent).toHaveBeenCalledWith('ops', expect.anything(), null, [], []);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'self' }));
  });

  it('built-in path is unchanged: no spaceVersion in meta, PONG-style passthrough still streams', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('PONG');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'ping', sessionId: 's'.repeat(36) })));
    expect(body).toContain('PONG');
    expect(body).toContain('[DONE]');
    expect(body).not.toContain('spaceVersion'); // built-in meta carries no space influence
    expect(body).not.toContain('customAgent');
  });

  it('custom path surfaces spaceVersion in meta and the trace (when the resolver carries one)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: ['cis'], skills: [] }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', agentVersion: 2, skillHashes: ['h1'], spaceVersion: 7 });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'cis check', section: 'security', sessionId: 's'.repeat(36) })));
    expect(body).toContain('"spaceVersion":7');
    expect(recordCustomAgentTrace).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'compliance', spaceVersion: 7 }));
  });
});

describe('cross-domain auto-synthesis (ADR-044)', () => {
  const multiRoute = {
    primary: 'network',
    ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }],
    method: 'llm' as const,
    multiDomain: true,
    selected: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }],
  };

  it('flag OFF: multiDomain route still uses the single path (regression lock)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    // MULTI_ROUTE_SYNTHESIS_ENABLED intentionally unset
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('single answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'EKS 파드가 RDS 연결 안돼', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(body).not.toContain('합성된 답변'); // single path, not the synth output
  });

  it('flag ON + multiDomain: fans out per-gateway and synthesizes', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockImplementation(async ({ gateway }: { gateway: string }) => `ans-${gateway}`);
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'EKS 파드가 RDS 연결 안돼', sessionId: 's'.repeat(36) })));
    // gate CRITICAL: one invoke per selected gateway, each with its OWN gateway
    expect(invokeAgent).toHaveBeenCalledTimes(2);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'network' }));
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'data' }));
    // synthesize gets BOTH survivors
    expect(synthesizeStream).toHaveBeenCalledWith('EKS 파드가 RDS 연결 안돼', [
      { gateway: 'network', text: 'ans-network' },
      { gateway: 'data', text: 'ans-data' },
    ]);
    expect(body).toContain('합성된 답변');
    expect(body).toContain('"via":"multi:network+data"'); // gate MINOR: via in meta
    expect(body).toContain('[DONE]');
  });

  it('one gateway fails: synthesize runs over the survivor only', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockImplementation(async ({ gateway }: { gateway: string }) =>
      gateway === 'data' ? Promise.reject(new Error('data down')) : 'ans-network');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).toHaveBeenCalledWith('q', [{ gateway: 'network', text: 'ans-network' }]);
  });

  it('all gateways fail: emits an error frame, no synthesis', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockRejectedValue(new Error('all down'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(body).toContain('"error"');
  });

  it('custom-agent pick suppresses fan-out even on a multiDomain route', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: ['cis'], skills: [] }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', skillHashes: [] });
    invokeAgent.mockResolvedValue('custom answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'cis check', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(body).not.toContain('합성된 답변'); // single path, not the synth output
  });

  it('only one active selected route: no fan-out (single path)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'network',
      ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'container', score: 0.6, active: false }],
      method: 'llm', multiDomain: false,
      selected: [{ key: 'network', score: 0.9, active: true }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('single');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
  });
});
