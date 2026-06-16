// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import DiagnosisView from './DiagnosisView';

afterEach(cleanup);

function mockCapture(reports: Array<Record<string, unknown>> = []) {
  const posts: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (method === 'POST' && path === '/api/diagnosis') {
      posts.push(JSON.parse(String(init?.body)));
      return resp({ job_id: 'j1', report_id: 1, tier: 'deep', model: 'sonnet' }, 202);
    }
    if (method === 'GET' && path === '/api/diagnosis') return resp({ reports });
    if (method === 'GET' && path.startsWith('/api/diagnosis/')) {
      const id = Number(path.split('/').pop());
      const r = reports.find((x) => (x as { id: number }).id === id) ?? { id, tier: 'deep', status: 'running' };
      return resp({ report: r, markdown: null });
    }
    return resp({}, 404);
  }));
  return posts;
}

function resp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function mockList(reports: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (method === 'GET' && path === '/api/diagnosis') return resp({ reports });
    if (method === 'GET' && path.startsWith('/api/diagnosis/')) {
      const id = Number(path.split('/').pop());
      const r = reports.find((x) => (x as { id: number }).id === id) ?? reports[0];
      return resp({ report: r, markdown: (r as { status: string }).status === 'succeeded' ? '# ok' : null });
    }
    return resp({}, 404);
  }));
}

describe('DiagnosisView — live progress & never-stuck UI (A6)', () => {
  it('shows live per-section progress for a running report (not a bare spinner)', async () => {
    mockList([{ id: 5, tier: 'mid', status: 'running', created_at: 't',
                progress: { current: 3, total: 9, section: '네트워크', phase: 'render' } }]);
    render(<DiagnosisView />);
    // the in-progress panel shows the current section + an N/total counter (sidebar shows it too →
    // assert via the progressbar's container, which is unique to the main panel)
    const bar = await screen.findByRole('progressbar');
    const panel = bar.parentElement as HTMLElement;
    expect(within(panel).getByText(/3\s*\/\s*9/)).toBeTruthy();   // N/total counter
    expect(within(panel).getByText(/네트워크/)).toBeTruthy();      // current section title
  });

  it('surfaces a failed report with its error and a retry control', async () => {
    mockList([{ id: 6, tier: 'mid', status: 'failed', created_at: 't',
                error: 'reaped: worker failed or stale', progress: {} }]);
    render(<DiagnosisView />);
    expect(await screen.findByText(/worker failed or stale/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /재시도|다시 실행/ })).toBeTruthy();
  });
});

describe('DiagnosisView — deep tier + model selection', () => {
  it('offers a Deep tier option and a model radio (default Sonnet) only for deep', async () => {
    mockCapture();
    render(<DiagnosisView />);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: /deep/i })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull(); // mid → no model radio
    fireEvent.change(select, { target: { value: 'deep' } });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect((screen.getByRole('radio', { name: /sonnet/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('omits model in the POST body for mid', async () => {
    const posts = mockCapture();
    render(<DiagnosisView />);
    await screen.findByRole('combobox');
    fireEvent.click(screen.getByRole('button', { name: /진단 실행/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ tier: 'mid' });
  });

  it('posts the selected model for deep (opus)', async () => {
    const posts = mockCapture();
    render(<DiagnosisView />);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'deep' } });
    fireEvent.click(screen.getByRole('radio', { name: /opus/i }));
    fireEvent.click(screen.getByRole('button', { name: /진단 실행/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ tier: 'deep', model: 'opus' });
  });

  it('shows the model in the report list for a deep report', async () => {
    mockList([{ id: 9, tier: 'deep', model: 'opus', status: 'succeeded', created_at: 't', progress: {} }]);
    render(<DiagnosisView />);
    const row = await screen.findByRole('button', { name: /#9/ });
    expect(row.textContent).toMatch(/deep/);
    expect(row.textContent).toMatch(/opus/);
  });
});
