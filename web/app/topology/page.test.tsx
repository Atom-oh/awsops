// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { DEFAULT_SCOPE, setActiveScope } from '@/lib/account-context';
import TopologyPage from './page';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
class DOMMatrixReadOnlyStub { m22 = 1; }
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body));
const region = 'us-east-1';
const captured = '2026-09-11T11:00:00Z';
type InventoryResponse = { rows: Record<string, unknown>[]; run: Record<string, unknown> | null };
function serve(failedTypes: string[] | 'all' = [], inventory: Record<string, Partial<InventoryResponse>> = {}) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/eks') return json({ clusters: [] });
    if (url.pathname === '/api/nfm') return json({ monitors: [], scopeCount: 0 });
    if (url.pathname === '/api/graph') return json({
      class: 'trace', account: 'self', captured_at: null, nodes: [], edges: [],
    });
    if (url.pathname.startsWith('/api/inventory/')) {
      if (failedTypes === 'all' || failedTypes.includes(url.pathname.split('/').pop()!)) {
        return new Response(JSON.stringify({ message: 'inventory unavailable' }), { status: 503 });
      }
      const rows: Record<string, unknown>[] = [];
      if (url.pathname.endsWith('/target_group')) rows.push({
        resource_id: 'tg-orders', region, data: {
          target_type: 'ip', vpc_id: 'vpc-a', target_health_descriptions: [{ Target: { Id: '10.0.1.10' } }],
        },
      });
      if (url.pathname.endsWith('/ecs_task')) rows.push({
        resource_id: 'task-orders', region, data: {
          cluster_arn: 'cluster/production', task_group: 'service:orders-api',
          attachments: [{ Details: [
            { Name: 'subnetId', Value: 'subnet-a' }, { Name: 'privateIPv4Address', Value: '10.0.1.10' },
          ] }],
        },
      });
      if (url.pathname.endsWith('/subnet')) rows.push({ resource_id: 'subnet-a', region, data: { vpc_id: 'vpc-a' } });
      return json({
        rows: rows.map(row => ({ ...row, captured_at: captured })),
        run: { status: 'succeeded', finished_at: '2026-09-11T12:00:00Z', last_success_at: '2026-09-11T12:00:00Z' },
        ...inventory[url.pathname.split('/').pop()!],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  return requests;
}

// Exercise the real Next hooks with reactive router context. History pushes intentionally do not
// dispatch popstate, matching same-page Link navigation. The browser suite owns actual Next routing.
function mount(initial = '/topology') {
  window.history.replaceState({}, '', initial);
  let update!: (href: string) => void;
  const entries = [initial];
  let index = 0;
  const publish = (href: string) => {
    window.history.replaceState({}, '', href);
    update(href);
  };
  const router: AppRouterInstance = {
    push: vi.fn(href => { entries.splice(++index); entries.push(href); publish(href); }),
    replace: vi.fn(href => { entries[index] = href; publish(href); }),
    back: () => { if (index > 0) publish(entries[--index]); },
    forward: () => { if (index + 1 < entries.length) publish(entries[++index]); },
    refresh: () => {}, prefetch: () => {},
  };
  function Harness() {
    const [href, setHref] = useState(initial);
    update = setHref;
    return <AppRouterContext.Provider value={router}>
      <SearchParamsContext.Provider value={new URL(href, 'http://localhost').searchParams}>
        <TopologyPage />
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>;
  }
  render(<Harness />);
  return router;
}

async function flowReady() {
  await screen.findByRole('button', { name: '서비스 + 네트워크' });
  await waitFor(() => expect(screen.queryByText('로딩 중…')).toBeNull());
}
async function e2eReady() {
  await screen.findByRole('region', { name: 'NFM 소스' });
}

describe('topology page URL and restored scope', () => {
  it.each([
    ['failed', '수집 실패'],
    ['partial', '부분 수집'],
    ['running', '수집 중'],
  ])('keeps retained rows usable for an HTTP 200 %s run and preserves the older successful collection', async (status, label) => {
    const lastSuccess = '2026-09-08T08:00:00Z';
    const failedCompletion = '2026-09-12T12:00:00Z';
    serve([], { target_group: { run: {
      status, finished_at: failedCompletion, last_success_at: lastSuccess, error: 'target discovery incomplete',
    } } });
    mount();
    await flowReady();
    const warning = screen.getAllByRole('alert').find(el => el.textContent?.includes('target_group'));
    expect(warning?.textContent).toContain(label);
    expect(warning?.textContent).toContain('저장된 구성');
    expect(warning?.textContent).toContain('target discovery incomplete');
    expect(warning?.textContent).not.toContain('조회 실패');
    expect(document.querySelector(`time[datetime="${lastSuccess}"]`)).not.toBeNull();
    expect(document.querySelector(`time[datetime="${failedCompletion}"]`)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'tg-orders' } });
    expect(screen.getByRole('button', { name: /^tg-orders\s*tg$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '서비스 + 네트워크' }));
    await e2eReady();
    const source = screen.getByRole('region', { name: '구성 소스' });
    expect(within(source).getByRole('alert').textContent).toContain(label);
    expect(source.querySelector(`time[datetime="${lastSuccess}"]`)).not.toBeNull();
    expect(source.querySelector(`time[datetime="${failedCompletion}"]`)).toBeNull();
  });

  it('uses the returned row capture range, not the newest type completion, for configuration timing', async () => {
    const oldest = '2026-09-02T01:00:00Z', newestRun = '2026-09-12T12:00:00Z';
    serve([], {
      target_group: { rows: [
        { resource_id: 'tg-old', region, captured_at: oldest, data: { target_type: 'instance' } },
        { resource_id: 'tg-new', region, captured_at: captured, data: { target_type: 'instance' } },
      ] },
      cloudfront: { run: { status: 'succeeded', finished_at: newestRun, last_success_at: newestRun } },
    });
    mount('/topology?view=e2e');
    const source = await screen.findByRole('region', { name: '구성 소스' });
    const range = await within(source).findByText('표시된 행 수집 범위', { exact: false });
    expect(range.querySelector(`time[datetime="${oldest}"]`)).not.toBeNull();
    expect(range.querySelector(`time[datetime="${captured}"]`)).not.toBeNull();
    expect(range.querySelector(`time[datetime="${newestRun}"]`)).toBeNull();
    expect(within(source).queryByText('구성 수집 시각', { exact: false })).toBeNull();
  });

  it.each([{ accounts: ['123456789012'] }, { accounts: '__all__' as const }, { accounts: ['self', '123456789012'] }])(
    'does not use the host run status or successful timestamp for scope %j', async ({ accounts }) => {
      window.localStorage.setItem('awsops:scope', JSON.stringify({ ...DEFAULT_SCOPE, accounts }));
      const hostSuccess = '2026-09-09T09:00:00Z';
      serve([], { target_group: { run: {
        status: 'failed', finished_at: '2026-09-12T12:00:00Z', last_success_at: hostSuccess, error: 'host-only failure',
      } } });
      mount('/topology?view=e2e');
      const source = await screen.findByRole('region', { name: '구성 소스' });
      await waitFor(() => expect(within(source).queryByText('구성을 불러오는 중…')).toBeNull());
      expect(within(source).queryByRole('alert')).toBeNull();
      expect(within(source).getByRole('status').textContent).toMatch(/수집 상태 미확인.*18/);
      expect(within(source).getByRole('status').textContent).not.toContain('target_group');
      expect(source.textContent).not.toContain('host-only failure');
      expect(source.querySelector(`time[datetime="${hostSuccess}"]`)).toBeNull();
      expect(source.querySelector(`time[datetime="${captured}"]`)).not.toBeNull();
    },
  );

  it('keeps an empty unknown-scope result inconclusive without an amber collection alert', async () => {
    window.localStorage.setItem('awsops:scope', JSON.stringify({ ...DEFAULT_SCOPE, accounts: '__all__' }));
    serve([], { target_group: { rows: [] }, ecs_task: { rows: [] }, subnet: { rows: [] } });
    mount();
    await flowReady();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('수집 상태 미확인');
    expect(screen.getByText('수집 상태 미확인으로 리소스 부재를 판단할 수 없습니다.')).toBeTruthy();
    expect(screen.queryByText(/그래프로 그릴 리소스가 없습니다/)).toBeNull();
  });

  it('does not infer successful collection or row capture time from an untyped run completion', async () => {
    serve([], { target_group: {
      rows: [{ resource_id: 'tg-unknown', region, data: { target_type: 'instance' } }],
      run: { finished_at: '2026-09-12T12:00:00Z' },
    } });
    mount('/topology?view=e2e');
    const source = await screen.findByRole('region', { name: '구성 소스' });
    await waitFor(() => expect(within(source).queryByText('구성을 불러오는 중…')).toBeNull());
    expect(source.textContent).toMatch(/target_group.*수집 상태 미확인/);
    expect(source.textContent).toMatch(/행 수집 시각 미확인:.*target_group/);
    expect(source.querySelector('time[datetime="2026-09-12T12:00:00Z"]')).toBeNull();
  });

  it('reports a total inventory failure without claiming the environment has no resources', async () => {
    serve('all');
    mount();
    await flowReady();
    expect(screen.getByRole('alert').textContent).toMatch(/조회 실패:.*cloudfront.*vpc.*security_group/);
    expect(screen.queryByText(/그래프로 그릴 리소스가 없습니다/)).toBeNull();
  });

  it('discloses failed VPC and security-group enrichment while keeping the loaded graph', async () => {
    serve(['vpc', 'security_group']);
    mount();
    await flowReady();
    expect(screen.getByRole('alert').textContent).toMatch(/vpc.*security_group/);
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'tg-orders' } });
    expect(screen.getByRole('button', { name: /^tg-orders\s*tg$/ })).toBeTruthy();
  });

  it('reacts to same-page opt-out, opt-in and history traversal without remounting the page', async () => {
    const requests = serve();
    const router = mount('/topology?view=e2e');
    await e2eReady();
    act(() => router.push('/topology'));
    await flowReady();
    expect(screen.queryByRole('region', { name: 'NFM 소스' })).toBeNull();
    act(() => router.push('/topology?view=e2e'));
    await e2eReady();
    act(() => router.back());
    await flowReady();
    act(() => router.forward());
    await e2eReady();
    expect(requests.filter(url => url.pathname === '/api/nfm/query')).toEqual([]);
  });

  it('uses router navigation for view controls and preserves unrelated deep-link parameters', async () => {
    serve();
    const router = mount('/topology?monitor=vpc-monitor&range=1800');
    await flowReady();
    fireEvent.click(screen.getByRole('button', { name: '서비스 + 네트워크' }));
    await e2eReady();
    expect(router.push).toHaveBeenCalledWith('/topology?monitor=vpc-monitor&range=1800&view=e2e', { scroll: false });
    fireEvent.click(screen.getByRole('button', { name: '구성 흐름으로 돌아가기' }));
    await flowReady();
    expect(router.push).toHaveBeenLastCalledWith('/topology?monitor=vpc-monitor&range=1800', { scroll: false });
  });

  it.each([
    { accounts: ['123456789012'], regions: ['us-east-1'], includeGlobal: false },
    { accounts: '__all__' as const, regions: '__all__' as const, includeGlobal: true },
  ])('restores persisted scope before any inventory or host observation request: %j', async scope => {
    window.localStorage.setItem('awsops:scope', JSON.stringify(scope));
    const requests = serve();
    mount('/topology?view=e2e');
    await e2eReady();
    await waitFor(() => expect(within(screen.getByRole('region', { name: '구성 소스' }))
      .queryByText('구성을 불러오는 중…')).toBeNull());
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(url => url.pathname.startsWith('/api/inventory/'))).toBe(true);
    expect(requests.every(url => url.searchParams.get('accounts') ===
      (scope.accounts === '__all__' ? '__all__' : scope.accounts.join(',')))).toBe(true);
    expect(requests.every(url => url.searchParams.get('regions') ===
      (scope.regions === '__all__' ? '__all__' : scope.regions.join(',')))).toBe(true);
    expect(requests.every(url => url.searchParams.get('includeGlobal') === (scope.includeGlobal ? '1' : '0'))).toBe(true);
    expect(requests.filter(url => ['/api/nfm', '/api/graph', '/api/eks', '/api/nfm/query'].includes(url.pathname))).toEqual([]);
  });

  it('passes existing subnet inventory into ECS resolution without a second subnet request', async () => {
    const requests = serve();
    mount();
    await flowReady();
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'orders-api' } });
    expect(await screen.findByRole('button', { name: /^orders-api\s*target$/ })).toBeTruthy();
    expect(requests.filter(url => url.pathname === '/api/inventory/subnet')).toHaveLength(1);
  });

  it('updates the cluster filter from same-page navigation and writes filter controls to the URL', async () => {
    serve();
    const router = mount('/topology?cluster=ecs%3Aproduction');
    await flowReady();
    // The cluster select is identified by its option, avoiding assumptions about toolbar order.
    const select = screen.getByRole('option', { name: 'Cluster: 전체' }).parentElement as HTMLSelectElement;
    expect(select.value).toBe('ecs:production');
    act(() => router.push('/topology'));
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'ecs:production' } });
    expect(router.push).toHaveBeenLastCalledWith('/topology?cluster=ecs%3Aproduction', { scroll: false });
    act(() => router.back());
    expect(select.value).toBe('');
  });

  it.each([
    { ...DEFAULT_SCOPE, accounts: ['123456789012'] },
    { ...DEFAULT_SCOPE, regions: ['us-west-2'] },
    { ...DEFAULT_SCOPE, includeGlobal: false },
  ])('clears selected resource details on scope changes: %j', async nextScope => {
    serve();
    mount();
    await flowReady();
    // Use the target group (always present, independently of ECS attribution).
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'tg-orders' } });
    fireEvent.click(await screen.findByRole('button', { name: /^tg-orders\s*tg$/ }));
    expect(screen.getByRole('button', { name: 'ARN 복사' })).toBeTruthy();
    act(() => setActiveScope(nextScope));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ARN 복사' })).toBeNull());
  });
});
