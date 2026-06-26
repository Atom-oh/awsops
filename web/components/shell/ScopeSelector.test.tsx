// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScopeSelector from './ScopeSelector';
import { getActiveScope } from '@/lib/account-context';

const accounts = [
  { accountId: '111111111111', alias: 'Host', isHost: true },
  { accountId: '210987654321', alias: 'Prod', isHost: false },
];
const regions = [
  { accountId: 'self', region: 'ap-northeast-2', enabled: true },
  { accountId: '210987654321', region: 'us-east-1', enabled: true },
  { accountId: '210987654321', region: 'eu-west-1', enabled: true },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts }), { status: 200 });
    if (url === '/api/accounts/regions') return new Response(JSON.stringify({ regions }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScopeSelector', () => {
  it('renders account and region scope controls from APIs', async () => {
    render(<ScopeSelector />);

    expect(await screen.findByText(/Accounts:/)).toBeTruthy();
    expect(screen.getByText(/Regions:/)).toBeTruthy();
    expect(screen.getByLabelText('Include global services')).toBeTruthy();
  });

  it('stores all accounts and multiple selected regions', async () => {
    render(<ScopeSelector />);
    await screen.findByText(/Accounts:/);

    fireEvent.click(screen.getByLabelText('All accounts'));
    await screen.findByLabelText('eu-west-1');
    fireEvent.click(screen.getByLabelText('us-east-1'));
    fireEvent.click(screen.getByLabelText('eu-west-1'));

    expect(getActiveScope()).toEqual({
      accounts: '__all__',
      regions: ['us-east-1', 'eu-west-1'],
      includeGlobal: true,
    });
  });

  it('can exclude global services from the active scope', async () => {
    render(<ScopeSelector />);
    await screen.findByText(/Accounts:/);

    fireEvent.click(screen.getByLabelText('Include global services'));

    await waitFor(() => expect(getActiveScope().includeGlobal).toBe(false));
  });
});
