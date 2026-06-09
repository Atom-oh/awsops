import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const invokeAgent = vi.fn();
const pickGateway = vi.fn();
const getEnabledCustomAgents = vi.fn();
const pickCustomAgent = vi.fn();
const resolveAgent = vi.fn();
const recordCustomAgentTrace = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/agentcore', () => ({ invokeAgent: (...a: unknown[]) => invokeAgent(...a) }));
vi.mock('@/lib/route', () => ({ pickGateway: (...a: unknown[]) => pickGateway(...a) }));
vi.mock('@/lib/catalog-source', () => ({ getEnabledCustomAgents: (...a: unknown[]) => getEnabledCustomAgents(...a) }));
vi.mock('@/lib/agent-resolver', () => ({
  pickCustomAgent: (...a: unknown[]) => pickCustomAgent(...a),
  resolveAgent: (...a: unknown[]) => resolveAgent(...a),
}));
vi.mock('@/lib/trace', () => ({ recordCustomAgentTrace: (...a: unknown[]) => recordCustomAgentTrace(...a) }));

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
  recordCustomAgentTrace.mockReset();
  // default to the built-in no-op shape
  getEnabledCustomAgents.mockResolvedValue([]);
  pickCustomAgent.mockReturnValue(null);
  resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
});

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
