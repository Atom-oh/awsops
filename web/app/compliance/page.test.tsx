// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));

import CompliancePage from './page';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CompliancePage', () => {
  function routedFetch(map: Record<string, unknown>) {
    return vi.fn((url: string) => {
      const key = Object.keys(map).find((k) => String(url).includes(k));
      return Promise.resolve({ ok: true, json: async () => (key ? map[key] : {}) });
    });
  }

  it('renders the benchmark selector + Run button', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/compliance/benchmarks': { benchmarks: [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }] },
      '/api/compliance/runs': { runs: [] },
    }));
    render(<CompliancePage />);
    expect(screen.getByText('Run Benchmark')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: 'CIS AWS v3.0.0' })).toBeTruthy());
  });

  it('renders the saved run history on mount', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/compliance/benchmarks': { benchmarks: [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }] },
      '/api/compliance/runs': { runs: [
        { id: 7, benchmark: 'cis_v300', status: 'succeeded', pass_rate: 82, started_at: '2026-06-18T00:00:00Z' },
      ] },
    }));
    render(<CompliancePage />);
    await waitFor(() => expect(screen.getByText('Recent runs')).toBeTruthy());
    expect(screen.getByText('succeeded')).toBeTruthy();
    expect(screen.getByText('82%')).toBeTruthy();
  });
});
