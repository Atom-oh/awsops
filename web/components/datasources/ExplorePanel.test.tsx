// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ExplorePanel from './ExplorePanel';

const INSTANCES = [
  { id: 1, name: 'prod-prom', kind: 'prometheus', authType: 'none', isDefault: true, connected: true },
  { id: 2, name: 'stg-prom', kind: 'prometheus', authType: 'basic', isDefault: false, connected: true },
];

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  global.fetch = mockFetch((url) => {
    if (url === '/api/datasources') return { datasources: INSTANCES };
    if (url === '/api/datasources/query') return { result: { shape: 'empty', note: '결과 없음' } };
    return {};
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ExplorePanel', () => {
  it('lists instances by name and runs a query against the selected instance id', async () => {
    const calls: { url: string; body?: string }[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string });
      return { ok: true, status: 200, json: async () => (url === '/api/datasources' ? { datasources: INSTANCES } : { result: { shape: 'empty' } }) };
    }) as unknown as typeof fetch;

    render(<ExplorePanel />);
    // instance option shows the NAME (not slug)
    await waitFor(() => expect(screen.getByText(/prod-prom \(prometheus\)/)).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } }); // pick stg-prom (id 2)
    fireEvent.change(screen.getByPlaceholderText(/PromQL/), { target: { value: 'up' } });
    fireEvent.click(screen.getByRole('button', { name: '실행' }));

    await waitFor(() => {
      const q = calls.find((c) => c.url === '/api/datasources/query');
      expect(q).toBeTruthy();
      expect(JSON.parse(q!.body!)).toMatchObject({ id: 2, query: 'up' });
    });
  });

  it('when scoped to an instanceId, shows the picker preselected to that instance (no dead-end)', async () => {
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    const sel = screen.getByRole('combobox') as HTMLSelectElement;
    expect(sel).toBeTruthy();
    await waitFor(() => expect(sel.value).toBe('1')); // preselected to the scoped instance id (numeric, not "select…")
  });
});
