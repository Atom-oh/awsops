// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SCOPE, setActiveScope } from '@/lib/account-context';
import TopologyPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
class DOMMatrixReadOnlyStub { m22 = 1; }
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/topology');
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(kind: 'ecs' | 'eks' = 'ecs', vpc = 'vpc-a') {
  const requests: URL[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/eks') return json({ clusters: kind === 'eks'
      ? [{ name: 'cluster-a', access: 'connected', region: 'us-east-1', vpcId: vpc }] : [] });
    if (url.pathname.endsWith('/incluster')) return json({ rows: url.searchParams.get('kind') === 'pods'
      ? [{ name: 'orders-a', namespace: 'shop', workload: 'orders', podIP: '10.0.1.10' }]
      : [{ name: 'orders-service', namespace: 'shop', ips: ['10.0.1.10'], targets: [{ ip: '10.0.1.10', pod: 'orders-a' }] }] });
    if (!url.pathname.startsWith('/api/inventory/')) throw new Error(`Unexpected request ${url}`);
    const type = url.pathname.split('/').pop();
    const rows = type === 'target_group' ? [{
      resource_id: 'tg-orders', region: 'us-east-1',
      data: { target_type: 'ip', vpc_id: 'vpc-a', target_health_descriptions: [{ Target: { Id: '10.0.1.10' } }] },
    }] : type === 'ecs_task' && kind === 'ecs' ? [{
      resource_id: 'task-orders', region: 'us-east-1',
      data: { cluster_arn: 'cluster/production', task_group: 'service:orders-api', attachments: [{ Details: [
        { Name: 'subnetId', Value: 'subnet-a' }, { Name: 'privateIPv4Address', Value: '10.0.1.10' },
      ] }] },
    }] : type === 'subnet' ? [{
      resource_id: 'subnet-a', region: 'us-east-1', data: { vpc_id: 'vpc-a' },
    }] : [];
    return json({ rows, run: { status: 'succeeded', finished_at: '2026-09-11T12:00:00Z', last_success_at: '2026-09-11T12:00:00Z' } });
  }));
  return requests;
}

async function search(text: string) {
  const input = await screen.findByPlaceholderText('리소스 이름 검색…');
  await waitFor(() => expect(screen.queryByText('로딩 중…')).toBeNull());
  fireEvent.change(input, { target: { value: text } });
}

describe('interactive topology graph input contract', () => {
  it('passes the already-loaded subnet inventory so ECS names and cluster filters survive', async () => {
    const requests = serve();
    render(<TopologyPage />);
    await search('orders-api');
    expect(await screen.findByRole('button', { name: /^orders-api\s*target$/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /production/ })).toBeTruthy();
    expect(requests.filter(url => url.pathname === '/api/inventory/subnet')).toHaveLength(1);
  });

  it('uses the scoped EKS producer when the pod and target share a VPC', async () => {
    serve('eks');
    render(<TopologyPage />);
    await search('shop/orders-service');
    expect(await screen.findByRole('button', { name: /^shop\/orders-service\s*target$/ })).toBeTruthy();
  });

  it('does not attribute a same-IP pod from a different VPC', async () => {
    serve('eks', 'vpc-other');
    render(<TopologyPage />);
    await search('shop/orders-service');
    expect(screen.queryByRole('button', { name: /^shop\/orders-service/ })).toBeNull();
  });

  it('restores a member account before starting any host-only EKS reads', async () => {
    setActiveScope({ ...DEFAULT_SCOPE, accounts: ['123456789012'] });
    const requests = serve();
    render(<TopologyPage />);
    await search('tg-orders');
    expect(await screen.findByRole('button', { name: /^tg-orders\s*tg$/ })).toBeTruthy();
    expect(requests.some(url => url.pathname.startsWith('/api/eks'))).toBe(false);
    expect(requests.every(url => url.searchParams.get('accounts') === '123456789012')).toBe(true);
  });
});
