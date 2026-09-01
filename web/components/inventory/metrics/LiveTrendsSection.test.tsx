// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { LiveTrendsSection } from './LiveTrendsSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const samples = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ t: new Date(Date.now() - (n - i) * 300_000).toISOString(), v: 40 + i }));

function setFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(String(url)).toContain('trends=1');
    return { ok, status: ok ? 200 : 500, json: async () => body };
  }));
}

describe('LiveTrendsSection (gap L118)', () => {
  it('renders sparklines, the ≤2-point fallback, and 데이터 불가 for a null series', async () => {
    setFetch({ trends: [
      { label: 'CPU', fmt: 'pct', samples: samples(10) },
      { label: 'Freeable Memory', fmt: 'gb', samples: samples(2) },
      { label: 'Connections', fmt: 'count', samples: null },
    ] });
    render(<LiveTrendsSection type="elasticache" id="cc-1" />);
    await waitFor(() => expect(screen.getByText('CPU')).toBeTruthy());
    expect(screen.getAllByText('Avg').length).toBe(1);        // 2-point series → fallback grid
    expect(screen.getAllByText('데이터 불가').length).toBe(1); // null series → honest empty
  });
  it('a 200 without trends (rolling-deploy skew) takes the error branch, never pinned loading', async () => {
    setFetch({ metrics: [] });
    render(<LiveTrendsSection type="elasticache" id="cc-1" />);
    await waitFor(() => expect(screen.getByText('메트릭 추이 조회 실패')).toBeTruthy());
  });
  it('an empty trends array (unknown type / total deny) renders 데이터 불가', async () => {
    setFetch({ trends: [] });
    render(<LiveTrendsSection type="msk" id="c" />);
    await waitFor(() => expect(screen.getByText('데이터 불가')).toBeTruthy());
  });
});
