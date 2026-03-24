'use client';

import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';

interface AccountInfo {
  accountId: string;
  alias: string;
  region: string;
  isHost?: boolean;
  features?: { costEnabled: boolean; eksEnabled: boolean; k8sEnabled: boolean };
}

interface AccountContextType {
  currentAccountId: string;  // '__all__' or 12-digit
  accounts: AccountInfo[];
  isMultiAccount: boolean;
  setCurrentAccountId: (id: string) => void;
  currentAccount: AccountInfo | undefined;
  getFeatures: () => { costEnabled: boolean; eksEnabled: boolean; k8sEnabled: boolean };
  refetchAccounts: () => Promise<void>;
}

export const ALL_ACCOUNTS = '__all__';
const LS_KEY = 'awsops_current_account';

const defaultContext: AccountContextType = {
  currentAccountId: ALL_ACCOUNTS,
  accounts: [],
  isMultiAccount: false,
  setCurrentAccountId: () => {},
  currentAccount: undefined,
  getFeatures: () => ({ costEnabled: true, eksEnabled: true, k8sEnabled: true }),
  refetchAccounts: async () => {},
};

const AccountContext = createContext<AccountContextType>(defaultContext);

export function useAccountContext() {
  return useContext(AccountContext);
}

export default function AccountProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [currentAccountId, setCurrentAccountIdState] = useState<string>(ALL_ACCOUNTS);

  const refetchAccounts = useCallback(async () => {
    try {
      const r = await fetch('/awsops/api/steampipe?action=config');
      const config = await r.json();
      if (config.accounts && config.accounts.length > 0) {
        const fetched: AccountInfo[] = config.accounts.map((a: Record<string, unknown>) => ({
          accountId: a.accountId as string,
          alias: a.alias as string,
          region: a.region as string,
          isHost: a.isHost as boolean | undefined,
          features: a.features as { costEnabled: boolean; eksEnabled: boolean; k8sEnabled: boolean } | undefined,
        }));
        setAccounts(fetched);
        setCurrentAccountIdState(prev => {
          if (prev === ALL_ACCOUNTS) return prev;
          if (fetched.some(a => a.accountId === prev)) return prev;
          try { localStorage.setItem(LS_KEY, ALL_ACCOUNTS); } catch {}
          return ALL_ACCOUNTS;
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved && (saved === ALL_ACCOUNTS || /^\d{12}$/.test(saved))) {
        setCurrentAccountIdState(saved);
      }
    } catch {}
    refetchAccounts();
  }, [refetchAccounts]);

  const setCurrentAccountId = useCallback((id: string) => {
    setCurrentAccountIdState(id);
    try { localStorage.setItem(LS_KEY, id); } catch {}
  }, []);

  const isMultiAccount = useMemo(() => accounts.length > 1, [accounts]);
  const currentAccount = useMemo(() => accounts.find(a => a.accountId === currentAccountId), [accounts, currentAccountId]);

  const getFeatures = useCallback(() => {
    if (!isMultiAccount) return { costEnabled: true, eksEnabled: true, k8sEnabled: true };
    if (currentAccountId === ALL_ACCOUNTS) {
      // Any account has the feature -> show it
      return {
        costEnabled: accounts.some(a => a.features?.costEnabled),
        eksEnabled: accounts.some(a => a.features?.eksEnabled),
        k8sEnabled: accounts.some(a => a.features?.k8sEnabled),
      };
    }
    return currentAccount?.features || { costEnabled: true, eksEnabled: true, k8sEnabled: true };
  }, [isMultiAccount, currentAccountId, accounts, currentAccount]);

  const contextValue = useMemo(() => ({
    currentAccountId, accounts, isMultiAccount, setCurrentAccountId, currentAccount, getFeatures, refetchAccounts,
  }), [currentAccountId, accounts, isMultiAccount, setCurrentAccountId, currentAccount, getFeatures, refetchAccounts]);

  return (
    <AccountContext.Provider value={contextValue}>
      {children}
    </AccountContext.Provider>
  );
}
