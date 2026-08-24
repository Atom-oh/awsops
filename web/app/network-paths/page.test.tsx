// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import NetworkPathsPage from './page';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup);
beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

function mockFetches(opts: { gateOff?: boolean; checks?: unknown[]; runs?: unknown[]; runDetail?: unknown } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/me')) return { ok: true, status: 200, json: async () => ({ sub: 'u-1', groups: [], isAdmin: false }) } as Response;
    if (u === '/api/network-paths' || u.endsWith('/api/network-paths')) {
      if (opts.gateOff) return { ok: false, status: 503, json: async () => ({ status: 'unconfigured' }) } as Response;
      if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ check: { id: 'chk-1', name: 'new' } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ checks: opts.checks ?? [] }) } as Response;
    }
    if (/\/api\/network-paths\/[^/]+\/runs$/.test(u)) {
      if (init?.method === 'POST') return { ok: true, status: 202, json: async () => ({ run: { id: 'run-1', status: 'queued' } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ runs: opts.runs ?? [] }) } as Response;
    }
    if (/\/api\/network-path-runs\//.test(u)) {
      return { ok: true, status: 200, json: async () => ({ run: opts.runDetail ?? null }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}

describe('/network-paths', () => {
  it('shows an honest empty state when the feature flag is off', async () => {
    mockFetches({ gateOff: true });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText(/비활성화/)).toBeTruthy());
  });

  it('shows an empty state when enabled but no checks exist', async () => {
    mockFetches({ checks: [] });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText(/저장된 경로 점검이 없습니다/)).toBeTruthy());
  });

  it('renders a saved check list and, on selection, its run history', async () => {
    mockFetches({
      checks: [{ id: 'chk-1', name: 'web -> db', source_account_id: '123456789012', created_by_sub: 'u-1', definition: {}, created_at: '', updated_at: '', deleted_at: null }],
      runs: [{ id: 'run-1', check_id: 'chk-1', requested_by_sub: 'u-1', status: 'succeeded', overall_status: 'allowed', created_at: '2026-08-19', finished_at: '2026-08-19' }],
    });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText('web -> db')).toBeTruthy());
    fireEvent.click(screen.getByText('web -> db'));
    await waitFor(() => expect(screen.getByText(/succeeded/)).toBeTruthy());
  });

  it('renders the checklist with not_run shown distinctly from unknown, and never wires a run button to the validation bundle', async () => {
    const runDetail = {
      id: 'run-1', check_id: 'chk-1', requested_by_sub: 'u-1', definition_snapshot: {},
      status: 'succeeded', phase: 'conclude', overall_status: 'blocked',
      validation_bundle: { commands: ['aws ec2 describe-security-groups --group-ids sg-1'] },
      worker_job_id: 'job-1', created_at: '2026-08-19', finished_at: '2026-08-19',
      candidates: [{ candidate_id: 'c1', candidate_kind: 'primary', status: 'blocked', first_blocker: 'security_group' }],
      steps: [
        { candidate_id: 'c1', account_id: 'a', region: 'r', ordinal: 0, layer: 'security_group', status: 'blocked', resource: 'sg-1', summary: 'denied', evidence: null, observed_at: null },
        { candidate_id: 'c1', account_id: 'a', region: 'r', ordinal: 1, layer: 'nacl', status: 'not_run', resource: null, summary: '', evidence: null, observed_at: null },
      ],
    };
    mockFetches({
      checks: [{ id: 'chk-1', name: 'web -> db', source_account_id: '123456789012', created_by_sub: 'u-1', definition: {}, created_at: '', updated_at: '', deleted_at: null }],
      runs: [{ id: 'run-1', check_id: 'chk-1', requested_by_sub: 'u-1', status: 'succeeded', overall_status: 'blocked', created_at: '2026-08-19', finished_at: '2026-08-19' }],
      runDetail,
    });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText('web -> db')).toBeTruthy());
    fireEvent.click(screen.getByText('web -> db'));
    await waitFor(() => expect(screen.getByText(/succeeded/)).toBeTruthy());
    fireEvent.click(screen.getByText(/succeeded/));

    await waitFor(() => expect(screen.getByText('실행 안 됨')).toBeTruthy());
    expect(screen.queryByText('알 수 없음')).toBeNull();

    // Validation bundle renders as read-only text, never behind a run/execute control.
    await waitFor(() => expect(screen.getByText(/aws ec2 describe-security-groups/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /실행 안 됨|명령|run this/i })).toBeNull();
    const allButtons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(allButtons.some((t) => /명령을 실행/.test(t))).toBe(false);
  });
});
