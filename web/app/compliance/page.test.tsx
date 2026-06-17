// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));

import CompliancePage from './page';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CompliancePage', () => {
  it('renders the benchmark selector + Run button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ benchmarks: [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }] }),
      }),
    );
    render(<CompliancePage />);
    expect(screen.getByText('Run Benchmark')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: 'CIS AWS v3.0.0' })).toBeTruthy());
  });
});
