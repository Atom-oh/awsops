// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import EksPage from './page';

afterEach(cleanup);

const clusters = [
  { name: 'conn', status: 'ACTIVE', version: '1.30', region: 'ap-northeast-2', vpcId: 'vpc-1', platformVersion: 'eks.5', access: 'connected', runtime: false },
  { name: 'ready', status: 'ACTIVE', version: '1.30', region: 'ap-northeast-2', vpcId: 'vpc-2', platformVersion: 'eks.5', access: 'entry-only', runtime: false },
  { name: 'cold', status: 'ACTIVE', version: '1.29', region: 'ap-northeast-2', vpcId: 'vpc-3', platformVersion: 'eks.4', access: 'no-entry', runtime: false },
];

function mockFetch(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const h = handlers[key];
    if (!h) throw new Error(`unmocked: ${key}`);
    const { status, body } = h(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('EKS list page (ADR buildout)', () => {
  it('renders a connected cluster as a link, others as plain text', async () => {
    mockFetch({ 'GET /api/eks': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('conn')).toBeTruthy());
    expect(screen.getByText('conn').closest('a')).toBeTruthy();
    expect(screen.getByText('ready').closest('a')).toBeNull();
    // non-admin: no register buttons
    expect(screen.queryByText('조회 등록')).toBeNull();
  });

  it('admin sees the register button and a successful POST refreshes the list', async () => {
    let registered = false;
    mockFetch({
      'GET /api/eks': () => ({
        status: 200,
        body: { clusters: registered ? clusters.map((c) => (c.name === 'ready' ? { ...c, access: 'connected', runtime: true } : c)) : clusters, admin: true },
      }),
      'POST /api/eks/ready/register': () => { registered = true; return { status: 200, body: { registered: true } }; },
    });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    fireEvent.click(screen.getByText('조회 등록'));
    await waitFor(() => expect(screen.getByText(/등록 완료/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('ready').closest('a')).toBeTruthy());
  });

  it('409 shows the onboarding guide with copyable commands', async () => {
    mockFetch({
      'GET /api/eks': () => ({ status: 200, body: { clusters, admin: true } }),
      'POST /api/eks/cold/register': () => ({
        status: 409,
        body: { registered: false, guide: { commands: ['aws eks create-access-entry --cluster-name cold', 'aws eks associate-access-policy --cluster-name cold'], note: 'make configure 안내' } },
      }),
    });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('cold')).toBeTruthy());
    fireEvent.click(screen.getByText('온보딩 가이드'));
    await waitFor(() => expect(screen.getByText(/cold 온보딩 가이드/)).toBeTruthy());
    expect(screen.getByText(/create-access-entry/)).toBeTruthy();
    expect(screen.getByText(/make configure/)).toBeTruthy();
  });
});
