'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { HTML_LANG, LOCALES, isLang, type Lang, makeT } from '@/lib/i18n';

interface I18nCtx {
  lang: Lang;
  locale: string;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const DEFAULT_CONTEXT: I18nCtx = {
  lang: 'ko',
  locale: LOCALES.ko,
  setLang: () => {},
  t: makeT('ko'),
};
const Ctx = createContext<I18nCtx>(DEFAULT_CONTEXT);
const STORAGE_KEY = 'awsops-lang';

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // SSR-safe initial = 'ko' (matches <html lang="ko">); client restores the saved choice post-mount.
  const [lang, setLangState] = useState<Lang>('ko');

  const applyDocumentLanguage = useCallback((next: Lang) => {
    if (typeof document !== 'undefined') document.documentElement.lang = HTML_LANG[next];
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isLang(saved)) {
        setLangState(saved);
        applyDocumentLanguage(saved);
      }
    } catch { /* localStorage unavailable — keep default */ }
  }, [applyDocumentLanguage]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    applyDocumentLanguage(next);
  }, [applyDocumentLanguage]);

  const value = useMemo<I18nCtx>(
    () => ({ lang, locale: LOCALES[lang], setLang, t: makeT(lang) }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  return useContext(Ctx);
}
