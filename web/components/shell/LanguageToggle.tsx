'use client';
import { useI18n } from './LanguageProvider';

/** ko→en→zh cycle. Shows the language you'd switch TO ('EN' while ko, '中文' while en, '한' while zh). */
export default function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  const next = lang === 'ko' ? 'en' : lang === 'en' ? 'zh' : 'ko';
  return (
    <button
      type="button"
      onClick={() => setLang(next)}
      aria-label="Toggle language"
      title={t('lang.toggleTitle')}
      className="rounded-md border border-ink-200 px-1.5 py-0.5 text-[11px] font-semibold text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800"
    >
      {t('lang.toggle')}
    </button>
  );
}
