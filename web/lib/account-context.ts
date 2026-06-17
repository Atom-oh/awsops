'use client';
// Client-side active-account context. Selection is per-tab (localStorage). BFF routes accept the
// active account as a `?account=<id>` query param (host/self → omitted → the task role's own creds).
import { useEffect, useState } from 'react';

const KEY = 'awsops:account';
export const ALL_ACCOUNTS = '__all__';

export function getActiveAccount(): string {
  if (typeof window === 'undefined') return 'self';
  try {
    return window.localStorage.getItem(KEY) || 'self';
  } catch {
    return 'self';
  }
}

export function setActiveAccount(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* ignore quota/availability */
  }
  window.dispatchEvent(new CustomEvent('awsops:accountchange', { detail: { id } }));
}

/** Query-param fragment for the active account. '' for host/self (default creds); else `account=<id>`. */
export function accountParam(id: string): string {
  return !id || id === 'self' ? '' : `account=${encodeURIComponent(id)}`;
}

/** React hook: current active account + setter (persists + broadcasts to other components). */
export function useActiveAccount(): [string, (id: string) => void] {
  const [id, setId] = useState('self');
  useEffect(() => {
    setId(getActiveAccount());
    const handler = () => setId(getActiveAccount());
    window.addEventListener('awsops:accountchange', handler);
    return () => window.removeEventListener('awsops:accountchange', handler);
  }, []);
  return [id, (v: string) => { setActiveAccount(v); setId(v); }];
}
