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
// invokeAgentStream (single-route path) delegates to the invokeAgent mock so existing tests —
// which set invokeAgent.mockResolvedValue/mockRejectedValue and assert its call args/count —
// keep working: the stream yields the resolved answer as one delta (the route reassembles it).
async function* invokeAgentStreamImpl(...a: unknown[]): AsyncGenerator<string> {
  const text = await invokeAgent(...a);
  if (text) yield text as string;
}
vi.mock('@/lib/agentcore', () => ({
  invokeAgent: (...a: unknown[]) => invokeAgent(...a),
  invokeAgentStream: (...a: unknown[]) => invokeAgentStreamImpl(...a),
}));
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
const listConfiguredSchemas = vi.fn();
vi.mock('@/lib/datasource-schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/datasource-schema')>()), // keep the real renderSchemaForPrompt
  listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a),
}));
const listDatasources = vi.fn();
vi.mock('@/lib/datasources', () => ({ listDatasources: (...a: unknown[]) => listDatasources(...a) }));
const synthesizeStream = vi.fn();
vi.mock('@/lib/synthesize', () => ({ synthesizeStream: (...a: unknown[]) => synthesizeStream(...a) }));
const assistantAnswer = vi.fn();
const isProductHelpIntent = vi.fn();
vi.mock('@/lib/assistant', () => ({
  assistantAnswer: (...a: unknown[]) => assistantAnswer(...a),
  isProductHelpIntent: (...a: unknown[]) => isProductHelpIntent(...a),
}));

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
  listConfiguredSchemas.mockReset(); listConfiguredSchemas.mockResolvedValue([]);
  listDatasources.mockReset(); listDatasources.mockResolvedValue([]);
  synthesizeStream.mockReset();
  // default: real-shaped async-generator returning a deterministic merged answer
  synthesizeStream.mockImplementation(async function* () { yield '합성된 답변'; });
  assistantAnswer.mockReset();
  assistantAnswer.mockResolvedValue('가이드 답변');
  isProductHelpIntent.mockReset();
  isProductHelpIntent.mockReturnValue(false); // default off so existing routing is unaffected
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

  it('flag on: EXPLICIT pin to an inactive section short-circuits with the honest 🔒 (ADR-044 §2)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    // user explicitly pinned /container → method:'pin' (an auto-routed inactive section now degrades
    // to the AWSops Assistant instead — see the 'AWSops Assistant' suite).
    classifyRoute.mockResolvedValue({
      primary: 'container',
      ranked: [{ key: 'container', score: 1, active: false }],
      method: 'pin', multiDomain: false, selected: [{ key: 'container', score: 1, active: false }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '파드 CrashLoop 원인', section: 'container', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(assistantAnswer).not.toHaveBeenCalled();
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

  it('records the inactive-section 🔒 guidance exchange too (explicit pin, spec §3)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u1' });
    classifyRoute.mockResolvedValue({ primary: 'container', ranked: [{ key: 'container', score: 1, active: false }], method: 'pin', multiDomain: false, selected: [{ key: 'container', score: 1, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: '파드 CrashLoop 원인', section: 'container', sessionId: 's'.repeat(36) })));
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


describe('request body bound (OOM guard)', () => {
  it('413 on an oversized body before parse', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
    const { POST } = await import('./route');
    const resp = await POST(req({ prompt: 'x'.repeat(600_000) })); // > 512KB chat cap
    expect(resp.status).toBe(413);
    expect(invokeAgent).not.toHaveBeenCalled();
  });
});

describe('datasource schema injection', () => {
  it('injects cached schemas as extraContext for the monitoring gateway', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'monitoring', skill: 'monitoring', agentName: 'monitoring', skillHashes: [] });
    classifyRoute.mockResolvedValue({ primary: 'monitoring', ranked: [{ key: 'monitoring', score: 1, active: true }], method: 'regex' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { metrics: ['up'], labels: ['job'] }, fetched_at: 't' }]);
    listDatasources.mockResolvedValue([{ id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true }]);
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'what is up' })));
    const arg = invokeAgent.mock.calls.at(-1)![0] as { extraContext?: string };
    expect(arg.extraContext).toContain('Datasource schemas');
    expect(arg.extraContext).toContain('prometheus'); // kind label
    expect(arg.extraContext).toContain('prod-prom');  // instance name label
  });

  it('injects ONLY the default instance per kind (no duplicate same-kind instances)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'monitoring', skill: 'monitoring', agentName: 'monitoring', skillHashes: [] });
    classifyRoute.mockResolvedValue({ primary: 'monitoring', ranked: [{ key: 'monitoring', score: 1, active: true }], method: 'regex' });
    // two prometheus instances cached; only id=1 is the default
    listConfiguredSchemas.mockResolvedValue([
      { integrationId: 1, kind: 'prometheus', schema: { metrics: ['up'] }, fetched_at: 't' },
      { integrationId: 2, kind: 'prometheus', schema: { metrics: ['down'] }, fetched_at: 't' },
    ]);
    listDatasources.mockResolvedValue([
      { id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p1', authType: 'none', isDefault: true, enabled: true },
      { id: 2, name: 'stg-prom', kind: 'prometheus', endpoint: 'http://p2', authType: 'none', isDefault: false, enabled: true },
    ]);
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'what is up' })));
    const ctx = (invokeAgent.mock.calls.at(-1)![0] as { extraContext?: string }).extraContext ?? '';
    expect(ctx).toContain('prod-prom');     // default injected
    expect(ctx).not.toContain('stg-prom');  // non-default NOT injected
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
    // synthesize gets BOTH survivors (3rd arg is the {abortSignal} opts)
    expect(synthesizeStream.mock.calls[0][0]).toBe('EKS 파드가 RDS 연결 안돼');
    expect(synthesizeStream.mock.calls[0][1]).toEqual([
      { gateway: 'network', text: 'ans-network' },
      { gateway: 'data', text: 'ans-data' },
    ]);
    expect(body).toContain('합성된 답변');
    expect(body).toContain('"via":"multi:network+data"'); // gate MINOR: via in meta
    expect(body).toContain('[DONE]');
  });

  it('threads cached datasource schema into the monitoring/data fan-out invokes only', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute); // selected [network, data] — data is an observability gateway
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { metrics: ['up'] }, fetched_at: 't' }]);
    listDatasources.mockResolvedValue([{ id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true }]);
    invokeAgent.mockImplementation(async ({ gateway }: { gateway: string }) => `ans-${gateway}`);
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'x', sessionId: 's'.repeat(36) })));
    const calls = invokeAgent.mock.calls.map((c) => c[0] as { gateway: string; extraContext?: string });
    expect(calls.find((c) => c.gateway === 'data')!.extraContext).toContain('prometheus'); // obs gateway gets the cache
    expect(calls.find((c) => c.gateway === 'network')!.extraContext).toBeUndefined();        // non-obs does not
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
    expect(synthesizeStream.mock.calls[0][1]).toEqual([{ gateway: 'network', text: 'ans-network' }]);
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

  it('gate MAJOR: recomputes multiDomain from ACTIVE selected — a stale inactive entry is dropped', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'network',
      ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'container', score: 0.6, active: false }],
      method: 'llm', multiDomain: true,
      selected: [{ key: 'network', score: 0.9, active: true }, { key: 'container', score: 0.6, active: false }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('single');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled(); // only network is active ⇒ <2 ⇒ no synthesis
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'network' }));
  });

  it('pin wins over fan-out: a pinned route never synthesizes', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'cost', ranked: [{ key: 'cost', score: 1, active: true }], method: 'pin',
      multiDomain: false, selected: [{ key: 'cost', score: 1, active: true }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
    invokeAgent.mockResolvedValue('pinned');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'EKS RDS 연결', section: 'cost', switchedFrom: 'network', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'cost' }));
  });

  it('explicit pin to an ENABLED custom agent is honored (ADR-044 §2 — pin > keyword/classifier)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: [], skills: [] }]);
    isCustomAgentEnabled.mockResolvedValue(true);
    // classifier would pick something else, and there is no keyword match — the pin must still win
    classifyRoute.mockResolvedValue({ primary: 'network', ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }], method: 'llm', multiDomain: true, selected: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }] });
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', skillHashes: [] });
    invokeAgent.mockResolvedValue('custom pinned answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'EKS RDS 연결 안돼', section: 'compliance', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();         // explicit pin suppresses fan-out
    expect(resolveAgent.mock.calls[0][0]).toBe('compliance'); // pin routed to the custom agent (not the classifier's 'network')
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'compliance' }));
    expect(body).toContain('"agentName":"compliance"');
  });

  it('explicit pin to a DISABLED/absent custom agent ⇒ honest message, no silent fallback (ADR-044 §2)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    getEnabledCustomAgents.mockResolvedValue([]); // 'ghost' is not an enabled agent in this space
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '아무거나', section: 'ghost', sessionId: 's'.repeat(36) })));
    expect(invokeAgent).not.toHaveBeenCalled();      // no silent fallback to keyword/classifier
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(body).toContain('ghost');
    expect(body).toContain('사용할 수 없습니다');
    expect(body).toContain('[DONE]');
  });

  it('thread is agent-agnostic: same threadId across two turns to different gateways (ADR-044 §4)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    const tid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    invokeAgent.mockResolvedValue('a');
    const { POST } = await import('./route');
    // turn 1 → cost
    classifyRoute.mockResolvedValue({ primary: 'cost', ranked: [{ key: 'cost', score: 1, active: true }], method: 'pin', multiDomain: false, selected: [{ key: 'cost', score: 1, active: true }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
    await readStream(await POST(req({ prompt: '비용', section: 'cost', threadId: tid, sessionId: 's'.repeat(36) })));
    // turn 2 → network, SAME thread
    classifyRoute.mockResolvedValue({ primary: 'network', ranked: [{ key: 'network', score: 1, active: true }], method: 'pin', multiDomain: false, selected: [{ key: 'network', score: 1, active: true }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    await readStream(await POST(req({ prompt: '연결', section: 'network', threadId: tid, sessionId: 's'.repeat(36) })));
    const calls = recordExchange.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ threadId: tid, gateway: 'cost' });
    expect(calls[1]).toMatchObject({ threadId: tid, gateway: 'network' }); // same thread, different agent
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

describe('AWSops Assistant (product help + inactive fallback)', () => {
  it('product-help intent → AWSops Assistant, not an AWS section agent', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    isProductHelpIntent.mockReturnValue(true);
    classifyRoute.mockResolvedValue({ primary: 'observability', ranked: [{ key: 'observability', score: 0.9, active: false }], method: 'regex', multiDomain: false, selected: [{ key: 'observability', score: 0.9, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'observability', skill: 'observability', agentName: 'observability', skillHashes: [] });
    assistantAnswer.mockResolvedValue('1) Integrations에서 Prometheus 등록 2) Skill 작성 3) Agent 생성');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'prometheus 분석 agent 만들기 /customization', sessionId: 's'.repeat(36) })));
    expect(assistantAnswer).toHaveBeenCalledWith('prometheus 분석 agent 만들기 /customization');
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(body).toContain('Prometheus'); // single token survives typewriter chunk()
    expect(body).toContain('"assistant":true');
    expect(body).toContain('"gateway":"assistant"');
    expect(body).not.toContain('🔒');
  });

  it('auto-routed INACTIVE section degrades to the Assistant (no 🔒 dead-end)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    isProductHelpIntent.mockReturnValue(false);
    // classifier auto-routed (method:'regex') to inactive observability
    classifyRoute.mockResolvedValue({ primary: 'observability', ranked: [{ key: 'observability', score: 0.9, active: false }], method: 'regex', multiDomain: false, selected: [{ key: 'observability', score: 0.9, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'observability', skill: 'observability', agentName: 'observability', skillHashes: [] });
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'prometheus p99 추세', sessionId: 's'.repeat(36) })));
    expect(assistantAnswer).toHaveBeenCalled();
    expect(body).toContain('답변'); // chunk() splits on spaces
    expect(body).not.toContain('🔒'); // no dead-end
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('EXPLICIT pin to an inactive section keeps the honest 🔒 message (not the Assistant)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    isProductHelpIntent.mockReturnValue(false);
    // user pinned /observability → classifyRoute returns method:'pin'
    classifyRoute.mockResolvedValue({ primary: 'observability', ranked: [{ key: 'observability', score: 1, active: false }], method: 'pin', multiDomain: false, selected: [{ key: 'observability', score: 1, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'observability', skill: 'observability', agentName: 'observability', skillHashes: [] });
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '아무거나', section: 'observability', sessionId: 's'.repeat(36) })));
    expect(assistantAnswer).not.toHaveBeenCalled();
    expect(body).toContain('🔒'); // explicit choice → honest unavailable message
  });
});

describe('typewriter delay and progressive status events', () => {
  it('has no artificial playback delay by default when env is unset', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('Hello World');

    const { POST } = await import('./route');
    const t0 = Date.now();
    const res = await POST(req({ prompt: 'hello', sessionId: 's'.repeat(36) }));
    await readStream(res);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(20);
  });

  it('emits event: status phase: analyzing frame before content delta and carries no delta key', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('Hello World');

    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'hello', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(200);

    const body = await readStream(res);

    expect(body).toContain('event: status\ndata: {"phase":"analyzing"}');

    const frames = body.split('\n\n').filter(Boolean);
    const statusFrames = frames.filter(f => f.includes('event: status'));
    expect(statusFrames.length).toBeGreaterThanOrEqual(1);

    for (const frame of statusFrames) {
      expect(frame).not.toContain('"delta"');
    }

    const deltaFrames = frames.filter(f => f.includes('data: {"delta":'));
    expect(deltaFrames.length).toBeGreaterThan(0);
    expect(body).toContain('[DONE]');
  });
});

