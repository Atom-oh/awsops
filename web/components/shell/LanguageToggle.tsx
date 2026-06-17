'use client';
import { useI18n } from './LanguageProvider';

/** KO/EN toggle. Shows the language you'd switch TO ('EN' while ko, '한' while en). */
export default function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}
      aria-label="Toggle language"
      title={t('lang.toggleTitle')}
      className="rounded-md border border-ink-200 px-1.5 py-0.5 text-[11px] font-semibold text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800"
    >
      {t('lang.toggle')}
    </button>
  );
}
