'use client';
import { useI18n } from './LanguageProvider';
import type { Lang } from '@/lib/i18n';

// 4개 언어를 각 언어 고유 표기로 노출하는 버튼 스위치 (기존 순환 토글 대체).
const LANGS: ReadonlyArray<readonly [Lang, string]> = [['ko', '한국어'], ['en', 'English'], ['zh', '中文'], ['ja', '日本語']];

export default function LanguageToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-ink-200" role="group" aria-label="Language">
      {LANGS.map(([l, label]) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`whitespace-nowrap px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
            lang === l ? 'bg-brand-500/10 text-brand-700' : 'text-ink-400 hover:bg-ink-100 hover:text-ink-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
