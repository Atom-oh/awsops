'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type Lang, makeT } from '@/lib/i18n';

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx | null>(null);
const STORAGE_KEY = 'awsops-lang';

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // SSR-safe initial = 'ko' (matches <html lang="ko">); client restores the saved choice post-mount.
  const [lang, setLangState] = useState<Lang>('ko');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'ko' || saved === 'en') {
        setLangState(saved);
        document.documentElement.lang = saved;
      }
    } catch { /* localStorage unavailable — keep default */ }
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = l;
  }, []);

  const value = useMemo<I18nCtx>(() => ({ lang, setLang, t: makeT(lang) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n must be used within <LanguageProvider>');
  return c;
}
