'use client';

import { LanguageProvider } from '@/lib/i18n/LanguageContext';
import AccountProvider from '@/contexts/AccountContext';

// Client-side providers wrapper / 클라이언트 사이드 프로바이더 래퍼
export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <AccountProvider>
        {children}
      </AccountProvider>
    </LanguageProvider>
  );
}
