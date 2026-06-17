// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { accountParam, getActiveAccount, setActiveAccount, ALL_ACCOUNTS } from './account-context';

beforeEach(() => { window.localStorage.clear(); });

describe('accountParam', () => {
  it('host/self/empty → empty (default creds)', () => {
    expect(accountParam('self')).toBe('');
    expect(accountParam('')).toBe('');
  });
  it('target account → account=<id>', () => {
    expect(accountParam('210987654321')).toBe('account=210987654321');
  });
  it('all accounts → account=__all__', () => {
    expect(accountParam(ALL_ACCOUNTS)).toBe('account=__all__');
  });
});

describe('getActiveAccount / setActiveAccount', () => {
  it('defaults to self', () => {
    expect(getActiveAccount()).toBe('self');
  });
  it('persists the selection', () => {
    setActiveAccount('210987654321');
    expect(getActiveAccount()).toBe('210987654321');
  });
  it('broadcasts an awsops:accountchange event', () => {
    let fired = '';
    window.addEventListener('awsops:accountchange', (e) => { fired = (e as CustomEvent).detail.id; });
    setActiveAccount('__all__');
    expect(fired).toBe('__all__');
  });
});
