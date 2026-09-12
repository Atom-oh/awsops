// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
const push = vi.hoisted(() => vi.fn());
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'ko', tt: (s: string) => s }),
}));
// Exercise the real page labels, filtering and navigation without a layout-dependent canvas.
vi.mock('next/dynamic', () => ({
  default: () => ({ nodes, onNodeClick }: any) => <div>
    {nodes.map((node: any) => <button key={node.id} style={node.style} data-y={node.position.y}
      onClick={() => onNodeClick(null, node)}>{node.data.label}</button>)}
  </div>,
}));
vi.mock('@xyflow/react', () => ({ Background: () => null, Controls: () => null, Position: {} }));
import ServiceMapPage from './page';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockReset(); });

function renderPage() {
  const router: AppRouterInstance = {
    push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
  };
  render(<AppRouterContext.Provider value={router}><ServiceMapPage /></AppRouterContext.Provider>);
}
const snapshot = { class: 'trace', account: 'self', nodes: [], edges: [], captured_at: '2026-09-11T12:00:00Z' };
function mount(collection?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...snapshot, collection }))));
  renderPage();
}

it('labels queue attribution as unverified telemetry and never navigates it into AWS inventory', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: [{ id: 'queue:1', kind: 'queue', label: 'orders', meta: {
      environment: 'prod', sourceId: 'tempo:1', identityProvenance: 'aws_verified',
      claimedAccountId: '111122223333', claimedRegion: 'us-east-1',
      infra_ref: 'inventory:queue', cluster: 'claimed-cluster',
    } }], edges: [], captured_at: null,
  }) })));
  renderPage();
  const queue = await screen.findByRole('button', { name: /queue: orders/ });
  expect(queue.textContent).toContain('Telemetry claim');
  expect(queue.textContent).toContain('AWS identity unverified');
  expect(queue.textContent).toContain('claimedAccountId: 111122223333');
  expect(queue.textContent).toContain('claimedRegion: us-east-1');
  fireEvent.click(queue);
  expect(push).not.toHaveBeenCalled();
});

it('shows absent queue claims without substituting legacy reporter metadata', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: [{ id: 'queue:1', kind: 'queue', label: 'orders', meta: {
      claimedAccountId: null, claimedRegion: null, accountId: '444455556666', region: 'us-west-2',
    } }], edges: [], captured_at: null,
  }) })));
  renderPage();
  const queue = await screen.findByRole('button', { name: /queue: orders/ });
  expect(queue.textContent).toContain('claimedAccountId: —');
  expect(queue.textContent).toContain('claimedRegion: —');
  expect(queue.textContent).toContain('AWS identity unverified');
  expect(queue.textContent).not.toContain('444455556666');
});

it('reserves enough layout height for adjacent queue cards and their claim text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: ['one', 'two'].map(id => ({ id, kind: 'queue', label: id, meta: {} })),
    edges: [], captured_at: null,
  }) })));
  renderPage();
  const first = await screen.findByRole('button', { name: /queue: one/ });
  const second = screen.getByRole('button', { name: /queue: two/ });
  const height = Number.parseFloat(first.style.height);
  expect(height).toBeGreaterThan(100);
  expect(Math.abs(Number(first.dataset.y) - Number(second.dataset.y))).toBeGreaterThanOrEqual(height);
});

describe('service map collection compatibility', () => {
  it('retains service/network and flow navigation alongside the empty snapshot notice', async () => {
    mount();
    await waitFor(() => expect(screen.queryByText('불러오는 중…')).toBeNull());
    expect(screen.getByRole('link', { name: '서비스 + 네트워크' }).getAttribute('href')).toBe('/topology?view=e2e');
    expect(screen.getByRole('link', { name: '← 트래픽 흐름' }).getAttribute('href')).toBe('/topology');
    expect(screen.getByText('저장된 서비스 관측이 없습니다. 데이터소스 연결과 그래프 갱신을 확인하세요.')).toBeTruthy();
  });

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
