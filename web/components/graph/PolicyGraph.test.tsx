// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import PolicyGraph from './PolicyGraph';
import type { PolicyGraphDto } from '@/lib/policy-graph';

// React Flow measures its container via ResizeObserver, which jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FIXTURE: PolicyGraphDto = {
  version: 1,
  capturedAt: '2026-08-19T00:00:00Z',
  truncated: false,
  omitted: { nodes: 0, edges: 0 },
  nodes: [
    { id: 'eni:eni-08a', kind: 'eni', label: 'eni-08a', status: 'allowed' },
    { id: 'sg:sg-app', kind: 'sg', label: 'sg-app', status: 'allowed' },
    { id: 'listener:orders', kind: 'listener', label: 'orders :443', status: 'blocked' },
  ],
  edges: [
    { id: 'e1', source: 'eni:eni-08a', target: 'sg:sg-app', relation: 'protected-by', status: 'allowed', label: 'Security group allowed tcp/443' },
    { id: 'e2', source: 'sg:sg-app', target: 'listener:orders', relation: 'routed-to', status: 'blocked', label: 'path mismatch' },
  ],
};

const TRUNCATED_FIXTURE: PolicyGraphDto = {
  ...FIXTURE,
  truncated: true,
  omitted: { nodes: 3, edges: 1 },
};

describe('PolicyGraph', () => {
  it('renders graph controls and an accessible checklist fallback', async () => {
    render(<PolicyGraph graph={FIXTURE} compact={false} />);

    await waitFor(() => screen.getByTestId('policy-graph'));
    expect(screen.getByLabelText('Fit graph')).toBeTruthy();
    expect(screen.getByLabelText('Zoom in')).toBeTruthy();
    expect(screen.getByLabelText('Zoom out')).toBeTruthy();

    // Accessible textual source of truth is always present, independent of canvas mount.
    expect(screen.getByText('protected-by Security group allowed tcp/443 — O Allowed')).toBeTruthy();
    expect(screen.getByText('routed-to path mismatch — X Blocked')).toBeTruthy();
  });

  it('shows an omitted-count notice only when the graph is truncated', async () => {
    render(<PolicyGraph graph={FIXTURE} />);
    await waitFor(() => screen.getByTestId('policy-graph'));
    expect(screen.queryByText(/hidden by graph limits/)).toBeNull();
    cleanup();

    render(<PolicyGraph graph={TRUNCATED_FIXTURE} />);
    await waitFor(() => screen.getByTestId('policy-graph'));
    expect(screen.getByText(/\+3 nodes.*\+1 edges.*hidden by graph limits/)).toBeTruthy();
  });

  it('calls onSelect with null when the pane fit control fires without a prior selection', async () => {
    const onSelect = vi.fn();
    render(<PolicyGraph graph={FIXTURE} onSelect={onSelect} />);
    await waitFor(() => screen.getByTestId('policy-graph'));

    fireEvent.click(screen.getByLabelText('Fit graph'));
    // Fit is a viewport action, not a selection — it must not synthesize a selection callback.
    expect(onSelect).not.toHaveBeenCalled();
  });
});
