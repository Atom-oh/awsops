// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: 'en', tt: (s: string) => s }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@xyflow/react', () => ({ Background: () => null, Controls: () => null, Position: {} }));
import InfraPage from './page';
import ResourcePage from '../resource/[id]/page';
afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

it.each(['infra', 'resource'])('recovers %s saved-account restoration while the host read still holds admission', async page => {
  window.localStorage.setItem('awsops:account', '123456789012');
  let held = false, busyResponses = 0;
  const accountReads: string[] = [];
  const graph = (label: string) => ({ nodes: [{ id: 'alb:one', kind: 'alb', label }], edges: [],
    captured_at: null, collection: { status: 'ok', stale: false, sources: [] } });
  vi.stubGlobal('fetch', async (input: string) => {
    const account = new URL(input, 'http://localhost').searchParams.get('account')!;
    accountReads.push(account);
    if (account === 'self') {
      held = true;
      // Client abort does not release the server's in-flight read.
      return new Promise<Response>(resolve => setTimeout(() => {
        held = false; resolve(Response.json(graph('host graph')));
      }, 100));
    }
    if (held) {
      busyResponses++;
      return Response.json({ collection: { readStatus: 'unavailable', readReason: 'busy' } }, { status: 503 });
    }
    return Response.json(graph('member graph'));
  });
  render(page === 'infra' ? <InfraPage /> : <ResourcePage params={{ id: 'alb:one' }} />);
  await screen.findByText(page === 'infra' ? /노드 1 · 엣지 0/ : /관계 그래프 · member graph/);
  expect(busyResponses).toBeGreaterThan(0);
  expect(accountReads[0]).toBe('self');
  expect(accountReads.filter(account => account === '123456789012').length).toBeGreaterThan(1);
  expect(screen.queryByText(/조회 실패:/)).toBeNull();
});

it.each(['infra', 'resource'])('shows retained collection warnings in the %s graph', async page => {
  vi.stubGlobal('fetch', async () => Response.json({
    nodes: [], edges: [], captured_at: '2026-09-14T10:00:00Z',
    collection: { status: 'error', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'inventory:alb', status: 'error', scope: 'aggregate' }] },
  }));
  render(page === 'infra' ? <InfraPage /> : <ResourcePage params={{ id: 'alb:one' }} />);
  const warning = await screen.findByRole('alert');
  expect(warning.textContent).toContain('Collection failed');
  expect(warning.textContent).toContain('previous graph');
});
