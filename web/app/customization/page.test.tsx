// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import CustomizationPage from './page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/customization') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accountId: 'self',
          agents: [],
          skills: [],
          space: null,
        }),
      } as Response;
    }
    if (url === '/api/integrations') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ integrations: [] }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
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
