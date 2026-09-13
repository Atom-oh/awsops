// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import DatasourcesTab from './DatasourcesTab';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

const INSTANCES = [
  { id: 1, name: 'prod-prom', kind: 'prometheus', authType: 'none', isDefault: true, connected: true },
  { id: 2, name: 'stg-prom', kind: 'prometheus', authType: 'basic', isDefault: false, connected: true },
];
beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => ({
    ok: true, status: 200, json: async () => (url === '/api/datasources' ? { datasources: INSTANCES } : {}),
  })) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DatasourcesTab', () => {
  it('shows mirror-only configuration distinctly and uses inferred auth when editing', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ datasources: [{
      id: 7, name: 'migrated', kind: 'prometheus', endpoint: 'https://p/tenant',
      authType: 'bearer', isDefault: true, connected: true, configurationStatus: 'mirror_only',
    }] }) })) as unknown as typeof fetch;
    render(<DatasourcesTab canManage />);
    expect(await screen.findByText('기본 연결 설정 · 인스턴스 저장 필요')).toBeTruthy();
    expect(screen.getByText('AI로 진단')).toBeTruthy();
    fireEvent.click(screen.getByText('편집'));
    expect((screen.getByLabelText('Auth method') as HTMLSelectElement).value).toBe('bearer');
  });
  it('lists instances (name/type/auth/default) with an Explore link per row', async () => {
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    expect(screen.getByText('stg-prom')).toBeTruthy();
    expect(screen.getByText('★ 기본')).toBeTruthy();
    const links = screen.getAllByText('탐색 →') as HTMLAnchorElement[];
    expect(links[0].getAttribute('href')).toBe('/integrations/datasources/1');
  });

  it('hides Add/Edit/Delete for non-admins (read-only)', async () => {
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    expect(screen.queryByText('＋ 데이터소스 추가')).toBeNull();
    expect(screen.queryByText('편집')).toBeNull();
    expect(screen.queryByText('삭제')).toBeNull();
  });

  it('shows Add/Edit/Delete for admins and opens the form on Add', async () => {
    render(<DatasourcesTab canManage />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    expect(screen.getByText('＋ 데이터소스 추가')).toBeTruthy();
    expect(screen.getAllByText('삭제').length).toBe(2);
    expect(screen.getAllByText('편집').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('＋ 데이터소스 추가'));
    expect(screen.getByText('데이터소스 추가')).toBeTruthy();
  });

  it('renders KPI tiles rolled up from the fetched list (gap-audit L201)', async () => {
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    expect(screen.getByText('총 데이터소스')).toBeTruthy();
    expect(screen.getByText('설정 저장됨')).toBeTruthy();
    expect(screen.getByText('타입 종류')).toBeTruthy();
    expect(screen.getByText('기본 데이터소스')).toBeTruthy();
    // single default in this scenario → the tile names it
    expect(screen.getByText('★ prod-prom')).toBeTruthy();
  });

  it('shows the default COUNT when several kinds each have their own default', async () => {
    const multi = [
      { id: 1, name: 'prod-prom', kind: 'prometheus', authType: 'none', isDefault: true, connected: true },
      { id: 3, name: 'prod-loki', kind: 'loki', authType: 'none', isDefault: true, connected: true },
    ];
    global.fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200, json: async () => (url === '/api/datasources' ? { datasources: multi } : {}),
    })) as unknown as typeof fetch;
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-loki')).toBeTruthy());
    expect(screen.getByText('★ 2')).toBeTruthy();
  });

  it('re-fetches the list when the refresh button is clicked (gap-audit L202)', async () => {
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    const before = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByLabelText('새로고침'));
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1));
  });

  it('carries an AI-diagnose deep link ONLY on the DEFAULT row (gap-audit L204)', async () => {
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    // INSTANCES has two prometheus rows but only id 1 (prod-prom) is default — the chat gateway
    // resolves the kind's default, so a stg-prom link would diagnose the wrong datasource.
    expect(screen.getAllByText('AI로 진단')).toHaveLength(1);
    const links = screen.getAllByText('AI로 진단') as HTMLAnchorElement[];
    expect(links[0].getAttribute('href')).toContain('/assistant?q=');
    // the prompt is section-pinned (leading /section) so free-text routing can't misroute it
    const q = decodeURIComponent(links[0].getAttribute('href')!.replace('/assistant?q=', ''));
    expect(q.startsWith('/observability ')).toBe(true);
    expect(q).toContain('prod-prom');
    expect(q).not.toContain('stg-prom');
  });

  it('renders NO diagnose link for a kind without a connector section (jaeger)', async () => {
    const multi = [
      { id: 1, name: 'prod-prom', kind: 'prometheus', authType: 'none', isDefault: true, connected: true },
      { id: 9, name: 'jg', kind: 'jaeger', isDefault: true, connected: true },
    ];
    global.fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200, json: async () => (url === '/api/datasources' ? { datasources: multi } : {}),
    })) as unknown as typeof fetch;
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('jg')).toBeTruthy());
    // both rows are defaults, but only the supported kind (prometheus) gets a link
    expect(screen.getAllByText('AI로 진단')).toHaveLength(1);
    const links = screen.getAllByText('AI로 진단') as HTMLAnchorElement[];
    expect(decodeURIComponent(links[0].getAttribute('href')!)).toContain('prod-prom');
  });

  it('shows unavailable data as an error instead of an empty inventory', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ datasources: [], available: false }) })) as unknown as typeof fetch;
    render(<DatasourcesTab />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText('등록된 데이터소스가 없습니다.')).toBeNull();
  });

  it('keeps the row and reports a failed delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    global.fetch = vi.fn(async (_url, init) => ({
      ok: init?.method !== 'DELETE', status: init?.method === 'DELETE' ? 503 : 200,
      json: async () => ({ datasources: INSTANCES }),
    })) as unknown as typeof fetch;
    render(<DatasourcesTab canManage />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    fireEvent.click(screen.getAllByText('삭제')[0]);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('prod-prom')).toBeTruthy();
  });
});
