// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import EksClusterPage from './page';

vi.mock('next/navigation', () => ({ useParams: () => ({ cluster: 'c1' }) }));
afterEach(cleanup);
beforeEach(() => { vi.unstubAllGlobals(); });

function mockKind(handlers: Record<string, unknown[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const kind = new URL(String(url), 'http://x').searchParams.get('kind') ?? '';
    const rows = handlers[kind] ?? [];
    return { ok: true, status: 200, json: async () => ({ kind, rows }) } as Response;
  }));
}

describe('EKS [cluster] per-tab KPI/viz', () => {
  it('pods tab: KPI counts stay pre-filter while the table filters', async () => {
    mockKind({
      pods: [
        { name: 'p1', namespace: 'a', status: 'Running' },
        { name: 'p2', namespace: 'b', status: 'Pending' },
      ],
    });
    render(<EksClusterPage />);

    fireEvent.click(screen.getByText('Pods'));
    await waitFor(() => expect(screen.getByText('p1')).toBeTruthy());
    // both pods present initially
    expect(screen.getByText('p2')).toBeTruthy();

    // The Pending KPI tile (StatCard eyebrow) shows 1 (pre-filter). 'Pending'
    // also appears as p2's status cell, so scope to the uppercase eyebrow tile.
    const pendingTileOf = (): Element => {
      const eyebrow = screen
        .getAllByText('Pending')
        .find((el) => el.className.includes('uppercase'))!;
      return eyebrow.closest('.shadow-card')!;
    };
    expect(pendingTileOf().textContent).toContain('1');

    // Filter the table down to p1 only.
    fireEvent.change(screen.getByPlaceholderText('검색…'), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.queryByText('p2')).toBeNull());
    // table now shows only p1
    expect(screen.getByText('p1')).toBeTruthy();

    // KPI is computed from allRows (pre-filter) → Pending tile still 1, even
    // though p2 (the only Pending pod) is filtered out of the table.
    expect(pendingTileOf().textContent).toContain('1');
  });

  it('events tab renders warning rows sorted by lastSeenTs desc', async () => {
    mockKind({
      events: [
        { kind: 'Pod', object: 'a/x', reason: 'Old', message: 'old msg', count: 1, lastSeen: '1h', lastSeenTs: 1 },
        { kind: 'Pod', object: 'a/y', reason: 'New', message: 'new msg', count: 1, lastSeen: '1m', lastSeenTs: 9 },
      ],
    });
    const { container } = render(<EksClusterPage />);

    fireEvent.click(screen.getByText('Events'));
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy());
    expect(screen.getByText('Old')).toBeTruthy();

    // newest (lastSeenTs 9) must appear before oldest (1), despite server order.
    const text = container.textContent ?? '';
    expect(text.indexOf('New')).toBeLessThan(text.indexOf('Old'));
  });

  it('deployments tab shows degraded-first replica bars', async () => {
    mockKind({
      deployments: [
        { name: 'ok', namespace: 'a', ready: '3/3', available: 3 },
        { name: 'bad', namespace: 'a', ready: '1/3', available: 1 },
      ],
    });
    render(<EksClusterPage />);

    fireEvent.click(screen.getByText('Deployments'));
    await waitFor(() => expect(screen.getByText('ok')).toBeTruthy());

    // Degraded KPI present (bad is 1/3 → 1 degraded).
    expect(screen.getByText('Degraded')).toBeTruthy();
    // Replica availability list surfaces the degraded ratio. '1/3' also appears
    // in the table's Ready column, so scope to the availability Card root.
    const replicaCard = screen.getByText('레플리카 가용성').closest('.shadow-card')!;
    expect(replicaCard.textContent).toContain('1/3');
  });
});
