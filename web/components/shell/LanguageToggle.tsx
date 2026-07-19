'use client';
import { Languages } from 'lucide-react';
import { LANGUAGE_OPTIONS, type Lang } from '@/lib/i18n';
import { useI18n } from './LanguageProvider';

/** Compact, native language selector shared by the desktop and mobile sidebars. */
export default function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="relative flex shrink-0 items-center" title={t('lang.select')}>
      <Languages size={13} aria-hidden className="pointer-events-none absolute left-1.5 text-chrome-fg-muted" />
      <span className="sr-only">{t('lang.select')}</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        aria-label={t('lang.select')}
        className="h-7 appearance-none rounded-md border border-chrome-border bg-transparent py-0 pl-6 pr-1.5 text-[10px] font-semibold text-chrome-fg outline-none transition-colors hover:bg-chrome-active/40 focus:ring-2 focus:ring-brand-300"
      >
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.code} value={option.code} className="bg-card text-ink-800">
            {option.shortLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
