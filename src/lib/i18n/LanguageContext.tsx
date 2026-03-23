'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import en from './translations/en.json';
import ko from './translations/ko.json';

// Supported languages / 지원 언어
export type Language = 'ko' | 'en';

const translations: Record<Language, Record<string, string>> = { en, ko };

interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType>({
  lang: 'ko',
  setLang: () => {},
  t: (key: string) => key,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>('ko');

  // Load saved language preference / 저장된 언어 설정 로드
  useEffect(() => {
    const saved = localStorage.getItem('awsops-lang') as Language;
    if (saved && (saved === 'ko' || saved === 'en')) {
      setLangState(saved);
    }
  }, []);

  const setLang = useCallback((newLang: Language) => {
    setLangState(newLang);
    localStorage.setItem('awsops-lang', newLang);
    document.documentElement.lang = newLang;
  }, []);

  // Translation function with parameter interpolation / 파라미터 보간 번역 함수
  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    let text = translations[lang]?.[key] || translations['en']?.[key] || key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      });
    }
    return text;
  }, [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

export default LanguageProvider;
