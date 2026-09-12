// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import ServiceMapPage from './page';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const snapshot = { class: 'trace', account: 'self', nodes: [], edges: [], captured_at: '2026-09-11T12:00:00Z' };
function mount(collection?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...snapshot, collection }))));
  const router: AppRouterInstance = {
    push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
  };
  render(<AppRouterContext.Provider value={router}><ServiceMapPage /></AppRouterContext.Provider>);
}
describe('service map collection compatibility', () => {
  it('renders the current snapshot-only API without mounting a collection warning', async () => {
    mount();
    await waitFor(() => expect(screen.queryByText('불러오는 중…')).toBeNull());
    expect(screen.getByText('그래프 시점:', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('수집 상태 미확인')).toBeNull();
    expect(screen.queryByText(/trace 데이터 없음 — ClickHouse/)).toBeNull();
  });
  it('still displays partial and retained metadata when a compatible producer supplies it', async () => {
    mount({ status: 'partial', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'tempo:fixture', status: 'error', reasons: ['timeout'] }] });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/부분 수집.*오래된 데이터/);
    expect(alert.textContent).toContain('이전 그래프');
    expect(alert.textContent).toContain('timeout');
  });
});
