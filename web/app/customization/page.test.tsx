// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CustomizationPage from './page';

interface AgentRow { id: number; name: string; description: string; gateway: string; tier: string; enabled: boolean; version: number; skills: Array<{ name: string }>; agentType?: string; gateways?: string[]; }
interface SkillRow { id: number; name: string; description: string; tier: string; enabled: boolean; version: number; agentTypes?: string[]; }
interface IntegrationRow { id: number; name: string; kind: string; direction: string; capability: string; enabled: boolean; tier: string; receivePath?: string | null; }

let calls: { url: string; method: string; body?: string }[] = [];
let customizationStatus = 200;
let customizationGet: { accountId: string; agents: AgentRow[]; skills: SkillRow[]; space: { enabledAgentIds: number[]; enabledSkillIds: number[]; enabledIntegrationIds: number[]; toolAllowlist: string[]; version?: number } | null };
let integrationsGet: IntegrationRow[];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (url === '/api/customization' && method === 'GET') {
      if (customizationStatus !== 200) return { ok: false, status: customizationStatus, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => customizationGet } as Response;
    }
    if (url === '/api/integrations' && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ integrations: integrationsGet }) } as Response;
    }
    if (url === '/api/customization' && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, id: 42 }) } as Response;
    }
    if (url === '/api/customization' && method === 'PUT') {
      const b = JSON.parse((init!.body as string) ?? '{}');
      if (b.op === 'space') return { ok: true, status: 200, json: async () => ({ ok: true, version: 2 }) } as Response;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    if (url === '/api/integrations' && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 5, receivePath: null }) } as Response;
    }
    if (url === '/api/integrations' && method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
}

beforeEach(() => {
  calls = [];
  customizationStatus = 200;
  customizationGet = { accountId: 'self', agents: [], skills: [], space: null };
  integrationsGet = [];
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CustomizationPage workshop guide', () => {
  it('renders the sample-based workshop flow with console task names', async () => {
    render(<CustomizationPage />);

    await screen.findByText('Custom Agents & Skills');

    expect(screen.getByText('DevOps Agent Workshop Guide')).toBeTruthy();
    expect(screen.getByText('Workshop flow')).toBeTruthy();
    expect(screen.getByText('Agent Space')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('Skill')).toBeTruthy();
    expect(screen.getByText('MCP / Webhook')).toBeTruthy();
    expect(screen.getByText('Knowledge')).toBeTruthy();
    expect(screen.getByText('Configure secondary cloud source')).toBeTruthy();
    expect(screen.getByText('Configure Agent Space Webhook')).toBeTruthy();
    expect(screen.getAllByText('Ensure data schema matches DevOps Agent requirements').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Configure webhook authentication').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Generate URL and credentials').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/read-only 진단과 remediation proposal/).length).toBeGreaterThanOrEqual(1);
  });

  it('documents the console creation paths for agents, skills, and knowledge', async () => {
    render(<CustomizationPage />);

    await screen.findByText('Custom Agents & Skills');

    expect(screen.getByText('Agent 등록 방식')).toBeTruthy();
    expect(screen.getAllByText('Form').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Chat').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Skill 등록 방식')).toBeTruthy();
    expect(screen.getAllByText('Create skill').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Create skill with Chat').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Upload skill').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Import from repository').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Knowledge assets')).toBeTruthy();
    expect(screen.getAllByText('Instructions').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Skills').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Memories').length).toBeGreaterThanOrEqual(1);
  });

  it('keeps long prompt editors large enough for real authoring', async () => {
    const { container } = render(<CustomizationPage />);

    await screen.findByText('Custom Agents & Skills');

    const persona = screen.getByPlaceholderText(/persona/i) as HTMLTextAreaElement;
    const instructions = screen.getByPlaceholderText(/instructions/i) as HTMLTextAreaElement;

    expect(persona.rows).toBeGreaterThanOrEqual(8);
    expect(instructions.rows).toBeGreaterThanOrEqual(14);
    const largeEditors = Array.from(container.querySelectorAll('textarea')).filter((el) =>
      el.className.includes('min-h-'),
    );
    expect(largeEditors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('CustomizationPage access gates', () => {
  it('shows an admin-required message on 403', async () => {
    customizationStatus = 403;
    render(<CustomizationPage />);
    await screen.findByText('Admin access required (ADR-031).');
  });

  it('shows an Aurora-not-configured message on 400', async () => {
    customizationStatus = 400;
    render(<CustomizationPage />);
    await screen.findByText('Aurora is not configured — custom agents are unavailable.');
  });
});

describe('CustomizationPage agent/skill CRUD', () => {
  it('creates a new agent from the form and shows the disabled-by-default message', async () => {
    render(<CustomizationPage />);
    await screen.findByText('Custom Agents & Skills');

    fireEvent.change(screen.getAllByPlaceholderText('name (kebab-case)')[0], { target: { value: 'rds-investigator' } });
    fireEvent.change(screen.getByPlaceholderText('description'), { target: { value: 'investigates RDS' } });
    fireEvent.change(screen.getByPlaceholderText('persona (system prompt)'), { target: { value: 'You investigate RDS.' } });
    fireEvent.change(screen.getByPlaceholderText('routing keywords (comma-separated)'), { target: { value: 'rds, aurora' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => expect(screen.getByText('Created agent #42 — disabled; enable below')).toBeTruthy());
    const post = calls.find((c) => c.url === '/api/customization' && c.method === 'POST');
    expect(post).toBeTruthy();
    const body = JSON.parse(post!.body!);
    expect(body).toEqual(expect.objectContaining({
      kind: 'agent', name: 'rds-investigator', description: 'investigates RDS', persona: 'You investigate RDS.',
      routingKeywords: ['rds', 'aurora'],
    }));
  });

  it('creates a new skill from the form and shows the disabled-by-default message', async () => {
    render(<CustomizationPage />);
    await screen.findByText('Custom Agents & Skills');

    fireEvent.change(screen.getAllByPlaceholderText('name (kebab-case)')[1], { target: { value: 'rds-perf-investigation' } });
    fireEvent.change(screen.getByPlaceholderText(/instructions \(Markdown\)/), { target: { value: '# steps' } });
    fireEvent.click(screen.getByText('Create Skill'));

    await waitFor(() => expect(screen.getByText('Created skill #42 — disabled; enable below')).toBeTruthy());
    const post = calls.find((c) => c.url === '/api/customization' && c.method === 'POST');
    const body = JSON.parse(post!.body!);
    expect(body).toEqual(expect.objectContaining({ kind: 'skill', name: 'rds-perf-investigation', instructions: '# steps' }));
  });

  it('toggles a disabled custom agent to enabled via PUT', async () => {
    customizationGet.agents = [
      { id: 3, name: 'my-agent', description: 'd', gateway: 'ops', tier: 'custom', enabled: false, version: 1, skills: [] },
    ];
    render(<CustomizationPage />);
    await screen.findByText('Disabled');

    fireEvent.click(screen.getByText('Disabled'));

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/customization' && c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ op: 'enable', kind: 'agent', id: 3 });
    });
  });

  it('toggles an enabled custom skill to disabled via PUT', async () => {
    customizationGet.skills = [
      { id: 4, name: 'my-skill', description: 'd', tier: 'custom', enabled: true, version: 1 },
    ];
    render(<CustomizationPage />);
    await screen.findByText('my-skill');

    fireEvent.click(screen.getByText('Enabled'));

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/customization' && c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ op: 'disable', kind: 'skill', id: 4 });
    });
  });
});

describe('CustomizationPage Agent Space', () => {
  it('saves the Agent Space with the checked agent and typed tool allowlist', async () => {
    customizationGet.agents = [
      { id: 3, name: 'my-agent', description: 'd', gateway: 'ops', tier: 'custom', enabled: true, version: 1, skills: [] },
    ];
    render(<CustomizationPage />);
    await waitFor(() => expect(screen.getByLabelText('my-agent')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('my-agent'));
    fireEvent.change(screen.getByPlaceholderText(/simulate_principal_policy/), { target: { value: 'get_account_authorization_details' } });
    fireEvent.click(screen.getByText('Save Agent Space'));

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/customization' && c.method === 'PUT' && JSON.parse(c.body!).op === 'space');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual(expect.objectContaining({
        op: 'space', enabledAgentIds: [3], enabledSkillIds: [], enabledIntegrationIds: [], toolAllowlist: ['get_account_authorization_details'],
      }));
    });
    await screen.findByText(/Agent Space saved \(v2\)/);
  });
});

describe('CustomizationPage integrations (advanced)', () => {
  it('registers a custom egress integration and shows it as disabled', async () => {
    render(<CustomizationPage />);
    await screen.findByText('Custom Agents & Skills');

    fireEvent.click(screen.getByText('Advanced — register a custom integration'));
    const details = screen.getByText('Advanced — register a custom integration').closest('details') as HTMLElement;
    fireEvent.change(within(details).getByPlaceholderText('name (kebab-case)'), { target: { value: 'my-grafana' } });
    fireEvent.change(within(details).getByPlaceholderText('https endpoint'), { target: { value: 'https://grafana.example.com' } });
    fireEvent.click(within(details).getByText('Register integration'));

    await waitFor(() => expect(screen.getByText(/Created integration #5 — disabled/)).toBeTruthy());
    const post = calls.find((c) => c.url === '/api/integrations' && c.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse(post!.body!)).toEqual(expect.objectContaining({ name: 'my-grafana', kind: 'grafana', direction: 'egress', endpoint: 'https://grafana.example.com' }));
  });

  it('toggles an existing custom integration via PUT', async () => {
    integrationsGet = [
      { id: 6, name: 'my-grafana', kind: 'grafana', direction: 'egress', capability: 'read', enabled: false, tier: 'custom' },
    ];
    render(<CustomizationPage />);
    await screen.findByText('Disabled');

    fireEvent.click(screen.getByText('Disabled'));

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/integrations' && c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ op: 'enable', id: 6 });
    });
  });
});
