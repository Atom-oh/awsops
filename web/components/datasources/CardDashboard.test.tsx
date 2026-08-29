// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import CardDashboard from './CardDashboard';

const CARDS = {
  ready: [
    { cardKey: 'up_targets', title: '정상 타깃 수', viz: 'stat', unit: '', query: { tool: 'prometheus_query', expr: 'count(up == 1)', range: null } },
    { cardKey: 'cpu_usage', title: '노드 CPU 사용률', viz: 'timeseries', unit: '%', query: { tool: 'prometheus_query', expr: 'cpu_expr', range: { window: 3600, step: 60 } } },
  ],
  unavailable: [
    { cardKey: 'memory_available', title: '가용 메모리', missing: ['node_memory_MemAvailable_bytes'] },
  ],
};

// POST /api/datasources/query normalizes server-side → { result: NormalizedResult }.
const INSTANT_RESULT = { result: { shape: 'table', rows: [{ metric: '', value: 7, timestamp: '2026-08-28T00:00:00Z' }], columns: [{ key: 'metric', label: 'metric' }, { key: 'value', label: 'value' }, { key: 'timestamp', label: 'timestamp' }] } };
const SERIES_RESULT = { result: { shape: 'series', series: [{ t: '08-28 00:00', node: 1 }, { t: '08-28 00:01', node: 2 }], seriesXKey: 't', seriesKeys: ['node'] } };

function stubFetch({ failExpr }: { failExpr?: string } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes('/cards')) return { ok: true, json: async () => CARDS };
    const body = JSON.parse(init?.body ?? '{}');
    if (failExpr && body.query === failExpr) return { ok: false, json: async () => ({ error: 'boom' }) };
    return { ok: true, json: async () => (body.range ? SERIES_RESULT : INSTANT_RESULT) };
  }));
}

beforeEach(() => stubFetch());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CardDashboard', () => {
  it('renders ready card values after executing stored queries', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('정상 타깃 수')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('7')).toBeTruthy()); // instant stat value
    expect(screen.getByText('노드 CPU 사용률')).toBeTruthy();
  });

  it('sends the stored range to the query API for timeseries cards', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('정상 타깃 수')).toBeTruthy());
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(f.mock.calls.length).toBe(3)); // cards + 2 queries
    const bodies = f.mock.calls.filter(([u]) => String(u).includes('/query')).map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(bodies.find((b) => b.query === 'cpu_expr')?.range).toEqual({ window: 3600, step: 60 });
    expect(bodies.find((b) => b.query === 'count(up == 1)')?.range).toBeUndefined();
    expect(bodies.every((b) => b.id === 7)).toBe(true);
  });

  it('renders unavailable cards dimmed with missing tooltip', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('가용 메모리')).toBeTruthy());
    const el = screen.getByText('가용 메모리').closest('[title]');
    expect(el?.getAttribute('title')).toContain('node_memory_MemAvailable_bytes');
  });

  it('shows a per-card error while other cards still render', async () => {
    stubFetch({ failExpr: 'count(up == 1)' });
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText(/카드 쿼리 실패/)).toBeTruthy());
    expect(screen.getByText('노드 CPU 사용률')).toBeTruthy();
  });

  it('renders nothing when the instance has no card rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ready: [], unavailable: [] }) })));
    const { container } = render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));
    expect(container.textContent).toBe('');
  });

  it('fires onPick with the stored expr', async () => {
    const onPick = vi.fn();
    render(<CardDashboard instanceId={7} onPick={onPick} />);
    await waitFor(() => expect(screen.getAllByText(/Explore에서 열기/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/Explore에서 열기/)[0]);
    expect(onPick).toHaveBeenCalledWith('count(up == 1)');
  });
});
