// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import DatasourceForm from './DatasourceForm';
import { effectiveSavedConnection, mergeDatasourceConnection } from '@/lib/datasource-connection';

let calls: { url: string; method?: string; body?: string }[] = [];
beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string });
    const json = url.endsWith('/test') ? { ok: true, latencyMs: 42 } : { id: 9 };
    return { ok: true, status: 200, json: async () => json };
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DatasourceForm', () => {
  it('requires an explicit auth choice for an unresolved migrated authentication method', () => {
    render(<DatasourceForm initial={{ id: 7, name: 'legacy', kind: 'prometheus', endpoint: 'https://p', authType: '' }} onSaved={() => {}} onCancel={() => {}} />);
    expect((screen.getByLabelText('Auth method') as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'none' } });
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each(['prometheus', 'mimir', 'loki', 'tempo', 'clickhouse', 'jaeger', 'dynatrace', 'datadog'])('retains the %s tenant when authentication changes', kind => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: kind } });
    const orgInput = screen.getByText(/Org ID/).parentElement!.querySelector('input')!;
    fireEvent.change(orgInput, { target: { value: 'tenant-a' } });
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'bearer' } });
    expect(screen.getByDisplayValue('tenant-a')).toBeTruthy();
  });
  it('shows conditional credential fields per auth method', () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('checkbox', { name: '저장된 Org ID 지우기' })).toBeNull();
    // none → no credential inputs
    expect(screen.queryByText('Username')).toBeNull();
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'basic' } });
    expect(screen.getByText('Username')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'bearer' } });
    expect(screen.getByText('Token')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'custom_header' } });
    expect(screen.getByText('Header name')).toBeTruthy();
  });

  it('Save is disabled until name + endpoint are present (auth None is allowed)', () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: '저장' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'prod-prom' } });
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    expect(save.disabled).toBe(false); // no auth required
  });

  it('Test connection posts the unsaved form and shows a success banner', async () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    fireEvent.change(screen.getByText(/Org ID/).parentElement!.querySelector('input')!, { target: { value: 'tenant-a' } });
    fireEvent.click(screen.getByRole('button', { name: /연결 테스트/ }));
    await waitFor(() => expect(screen.getByText(/연결 성공/)).toBeTruthy());
    const t = calls.find((c) => c.url === '/api/datasources/test');
    expect(JSON.parse(t!.body!)).toMatchObject({ kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none', creds: { org_id: 'tenant-a' } });
  });

  it('Save (create) POSTs /manage with name+kind+endpoint+authType and calls onSaved', async () => {
    const onSaved = vi.fn();
    render(<DatasourceForm onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'prod-prom' } });
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const s = calls.find((c) => c.url === '/api/datasources/manage');
    expect(s!.method).toBe('POST');
    expect(JSON.parse(s!.body!)).toMatchObject({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none' });
  });

  it('edit mode PATCHes and locks the Type field', async () => {
    const onSaved = vi.fn();
    render(<DatasourceForm initial={{ id: 5, name: 'p', kind: 'loki', endpoint: 'http://l', authType: 'none' }} onSaved={onSaved} onCancel={() => {}} />);
    expect((screen.getByLabelText('Type') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const s = calls.find((c) => c.url === '/api/datasources/manage');
    expect(s!.method).toBe('PATCH');
    expect(JSON.parse(s!.body!)).toMatchObject({ id: 5, creds: {} }); // blank tenant means preserve, never an implicit clear
  });

  it('requires an explicit tenant clear before testing and saving an auth-none endpoint change', async () => {
    const initial = { id: 5, name: 'p', kind: 'prometheus', endpoint: 'https://metrics.example', authType: 'none' as const, isDefault: true, settings: { timeoutS: 20 } };
    const saved = effectiveSavedConnection(initial, { 5: { endpoint: initial.endpoint, org_id: 'tenant-a' } });
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string });
      try { mergeDatasourceConnection(initial.kind, JSON.parse(init!.body as string), saved); return { ok: true, json: async () => ({ ok: true }) }; }
      catch (error) { return { ok: false, json: async () => ({ error: (error as Error).message }) }; }
    }) as unknown as typeof fetch;
    render(<DatasourceForm initial={initial} onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /연결 테스트/ }));
    await waitFor(() => expect(screen.getByText(/연결 성공/)).toBeTruthy());
    expect(JSON.parse(calls[0].body!)).toMatchObject({ id: 5, settings: { timeoutS: 20 }, creds: {} });
    fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: 'https://new.example' } });
    fireEvent.click(screen.getByRole('button', { name: /연결 테스트/ }));
    await waitFor(() => expect(screen.getByText('Org ID를 입력하거나 저장된 Org ID 지우기를 선택하세요.')).toBeTruthy());
    const clear = screen.getByRole('checkbox', { name: '저장된 Org ID 지우기' }) as HTMLInputElement;
    expect(clear.checked).toBe(false);
    fireEvent.click(clear);
    expect((screen.getByText('Org ID (X-Scope-OrgID, 선택)').parentElement!.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'basic' } });
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'none' } });
    expect(clear.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /연결 테스트/ }));
    await waitFor(() => expect(screen.getByText(/연결 성공/)).toBeTruthy());
    fireEvent.click(clear);
    expect(screen.queryByText(/연결 성공/)).toBeNull();
    fireEvent.click(clear);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.at(-1)?.method).toBe('PATCH'));
    for (const call of calls.slice(-2)) expect(JSON.parse(call.body!)).toMatchObject({ endpoint: 'https://new.example', authType: 'none', creds: { org_id: '' } });
  });

  it('uses Datadog dual-key defaults and clears a previous provider credential', () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'bearer' } });
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'old-provider-token' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'datadog' } });
    expect((screen.getByLabelText('Auth method') as HTMLSelectElement).value).toBe('custom_header');
    expect(screen.getByLabelText('API key')).toBeTruthy();
    expect(screen.getByLabelText('Application key')).toBeTruthy();
    expect(screen.queryByDisplayValue('old-provider-token')).toBeNull();
  });

  it.each(['endpoint', 'tenant clear'])('invalidates a pending success when %s changes', async change => {
    let resolve!: (value: unknown) => void;
    global.fetch = vi.fn(() => new Promise((r) => { resolve = r; })) as unknown as typeof fetch;
    render(<DatasourceForm initial={{ id: 5, name: 'p', kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none' }} onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /연결 테스트/ }));
    if (change === 'endpoint') fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: 'http://other:9090' } });
    else fireEvent.click(screen.getByRole('checkbox', { name: '저장된 Org ID 지우기' }));
    resolve({ ok: true, json: async () => ({ ok: true, latencyMs: 1 }) });
    await waitFor(() => expect((screen.getByRole('button', { name: /연결 테스트/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/연결 성공/)).toBeNull();
  });
});

describe('connection settings (gap L203)', () => {
  it('sends a valid timeoutS; ClickHouse shows the Database field and sends it', async () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    // switch kind to clickhouse → Database field appears
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'clickhouse' } });
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'ch-1' } });
    fireEvent.change(screen.getByPlaceholderText(/clickhouse.internal/), { target: { value: 'http://ch:8123' } });
    fireEvent.change(screen.getByPlaceholderText('기본 10'), { target: { value: '30' } });
    fireEvent.change(screen.getByPlaceholderText('default'), { target: { value: 'metrics_db' } });
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/manage'))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.includes('/manage'))!.body!);
    expect(body.settings).toEqual({ timeoutS: 30, database: 'metrics_db' });
  });

  it('non-clickhouse kinds hide the Database field; an out-of-range timeout blocks save with an inline error', async () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.queryByPlaceholderText('default')).toBeNull(); // prometheus default kind
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'p-1' } });
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    fireEvent.change(screen.getByPlaceholderText('기본 10'), { target: { value: '999' } });
    // a typo must NOT silently clear the stored setting — save is blocked, error shown
    expect(screen.getByText(/1–60 사이의 정수/)).toBeTruthy();
    expect((screen.getByText('저장').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.url.includes('/manage'))).toBe(false);
  });
});
