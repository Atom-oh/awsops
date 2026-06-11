// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import OpencostPage from './page';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Route a mock fetch by URL + method.
function mockFetch(handlers: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = Object.keys(handlers).find((k) => url.includes(k)) ?? '';
    const { status = 200, body = {} } = handlers[key]?.(init) ?? { status: 404, body: {} };
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  });
}

describe('OpencostPage', () => {
  it('renders the install-status badge after loading clusters + status', async () => {
    global.fetch = mockFetch({
      '/api/eks': () => ({ body: { clusters: [{ name: 'fsi-demo-cluster' }] } }),
      '/status': () => ({ body: { installed: true, ready: true } }),
      '/api/opencost/fsi-demo-cluster': () => ({ body: { cluster: 'fsi-demo-cluster', config: null } }),
    }) as unknown as typeof fetch;
    render(<OpencostPage />);
    expect(await screen.findByText(/설치됨 · Ready/)).toBeTruthy();
  });

  it('shows the not-onboarded message when status is 404', async () => {
    global.fetch = mockFetch({
      '/api/eks': () => ({ body: { clusters: [{ name: 'other' }] } }),
      '/status': () => ({ status: 404, body: { status: 'error' } }),
      '/api/opencost/other': () => ({ body: { cluster: 'other', config: null } }),
    }) as unknown as typeof fetch;
    render(<OpencostPage />);
    expect((await screen.findAllByText(/온보딩되지 않았습니다/)).length).toBeGreaterThan(0);
  });

  it('Save issues a PUT to the config route', async () => {
    const calls: { url: string; method?: string }[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      const status = url.includes('/status') ? 200 : 200;
      const body = url.includes('/api/eks') ? { clusters: [{ name: 'fsi-demo-cluster' }] }
        : url.includes('/status') ? { installed: false, ready: false }
        : url.endsWith('/api/opencost/fsi-demo-cluster') && init?.method === 'PUT' ? { saved: true }
        : { cluster: 'fsi-demo-cluster', config: null };
      return { ok: true, status, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    render(<OpencostPage />);
    await screen.findByText(/미설치/);
    fireEvent.click(screen.getByText('저장 (admin)'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/api/opencost/fsi-demo-cluster'))).toBe(true));
  });
});
