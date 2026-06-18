// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
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
    const sel = screen.getByRole('combobox', { name: '데이터소스' }) as HTMLSelectElement;
    expect(sel).toBeTruthy();
    await waitFor(() => expect(sel.value).toBe('1')); // preselected to the scoped instance id (numeric, not "select…")
  });

  // --- Part 2: range dropdown + auto re-run ---
  it('renders a 범위 dropdown with Korean presets for range-capable kinds (default 즉시)', async () => {
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    const rangeSel = screen.getByRole('combobox', { name: '범위' }) as HTMLSelectElement;
    expect(rangeSel.value).toBe('0'); // 즉시 (instant) default
    for (const label of ['즉시', '5분', '15분', '1시간', '6시간', '24시간']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
    }
  });

  it('selecting a window posts range {window, step:auto}; default 즉시 posts range:false', async () => {
    const qbodies: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/datasources/query') qbodies.push(init?.body as string);
      return { ok: true, status: 200, json: async () => (url === '/api/datasources' ? { datasources: INSTANCES } : { result: { shape: 'empty' } }) };
    }) as unknown as typeof fetch;
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/PromQL/), { target: { value: 'up' } });
    fireEvent.click(screen.getByRole('button', { name: '실행' }));
    await waitFor(() => expect(qbodies.length).toBe(1));
    expect(JSON.parse(qbodies[0])).toMatchObject({ query: 'up', range: false }); // instant by default
    fireEvent.change(screen.getByRole('combobox', { name: '범위' }), { target: { value: '300' } });
    await waitFor(() => expect(qbodies.length).toBe(2));
    expect(JSON.parse(qbodies[1]).range).toMatchObject({ window: 300, step: 1 }); // autoStep(300)=max(1,round(1.2))=1
  });

  it('changing the range dropdown re-runs an existing query; typing or no-query does not', async () => {
    const qbodies: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/datasources/query') qbodies.push(init?.body as string);
      return { ok: true, status: 200, json: async () => (url === '/api/datasources' ? { datasources: INSTANCES } : { result: { shape: 'empty' } }) };
    }) as unknown as typeof fetch;
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox', { name: '범위' }), { target: { value: '900' } }); // no query yet → no run
    fireEvent.change(screen.getByPlaceholderText(/PromQL/), { target: { value: 'up' } }); // typing → no auto-run
    expect(qbodies.length).toBe(0);
    fireEvent.change(screen.getByRole('combobox', { name: '범위' }), { target: { value: '3600' } }); // with query → one run
    await waitFor(() => expect(qbodies.length).toBe(1));
    expect(JSON.parse(qbodies[0]).range).toMatchObject({ window: 3600 });
  });

  // --- Part 2 / Task 3: instant ranked bar chart (gated to prom/mimir vector) ---
  function mockApi(instances: unknown[], resultPayload: unknown) {
    global.fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url === '/api/datasources' ? { datasources: instances } : { result: resultPayload }),
    })) as unknown as typeof fetch;
  }
  const promInstant = (n: number) => ({
    shape: 'table',
    columns: [{ key: 'metric', label: 'metric' }, { key: 'value', label: 'value' }, { key: 'timestamp', label: 'timestamp' }],
    rows: Array.from({ length: n }, (_, i) => ({ metric: `m${i}`, value: i + 1, timestamp: 't' })),
  });

  it('instant prometheus result (≤30 numeric rows) renders the ranked bar (상위 결과)', async () => {
    mockApi(INSTANCES, promInstant(3));
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/PromQL/), { target: { value: 'topk(3, up)' } });
    fireEvent.click(screen.getByRole('button', { name: '실행' }));
    await waitFor(() => expect(screen.getByText('상위 결과')).toBeTruthy());
    const card = screen.getByText('상위 결과').closest('.bg-card') as HTMLElement;
    const order = within(card).getAllByTitle(/^m\d+$/).map((e) => e.getAttribute('title'));
    expect(order).toEqual(['m2', 'm1', 'm0']); // sorted desc by value (m2=3, m1=2, m0=1)
  });

  it('instant result with non-numeric value rows shows no bar (fail-closed)', async () => {
    mockApi(INSTANCES, { shape: 'table', columns: [{ key: 'metric', label: 'metric' }, { key: 'value', label: 'value' }], rows: [{ metric: 'a', value: '' }, { metric: 'b', value: 'x' }] });
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/PromQL/), { target: { value: 'up' } });
    fireEvent.click(screen.getByRole('button', { name: '실행' }));
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    expect(screen.queryByText('상위 결과')).toBeNull();
  });

  it('instant result with >30 rows shows no bar (table only)', async () => {
    mockApi(INSTANCES, promInstant(31));
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/PromQL/), { target: { value: 'up' } });
    fireEvent.click(screen.getByRole('button', { name: '실행' }));
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1)); // table rendered
    expect(screen.queryByText('상위 결과')).toBeNull();
  });

  it('a ClickHouse table with a numeric value column shows no bar', async () => {
    mockApi([{ id: 9, name: 'ch', kind: 'clickhouse' }], {
      shape: 'table',
      columns: [{ key: 'metric', label: 'metric' }, { key: 'value', label: 'value' }],
      rows: [{ metric: 'x', value: 5 }],
    });
    render(<ExplorePanel instanceId={9} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/SQL/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/SQL/), { target: { value: 'select 1' } });
    fireEvent.click(screen.getByRole('button', { name: '실행' }));
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    expect(screen.queryByText('상위 결과')).toBeNull();
  });

  it('a range (series) result renders AreaTrend, not the bar', async () => {
    mockApi(INSTANCES, { shape: 'series', series: [{ t: 1, value: 2 }], seriesXKey: 't', seriesYKey: 'value' });
    render(<ExplorePanel instanceId={1} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/PromQL/), { target: { value: 'up' } });
    fireEvent.change(screen.getByRole('combobox', { name: '범위' }), { target: { value: '3600' } });
    await waitFor(() => expect(screen.getByText('시계열')).toBeTruthy());
    expect(screen.queryByText('상위 결과')).toBeNull();
  });
});
