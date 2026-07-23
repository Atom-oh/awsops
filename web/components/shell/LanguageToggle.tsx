'use client';
import { useI18n } from './LanguageProvider';
import type { Lang } from '@/lib/i18n';

// KO/EN/CN/JA를 모두 노출하는 4-버튼 언어 스위치 (owner 요청 — 기존 순환 토글 대체).
const LANGS: ReadonlyArray<readonly [Lang, string]> = [['ko', 'KO'], ['en', 'EN'], ['zh', 'CN'], ['ja', 'JA']];

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
          className={`px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
            lang === l ? 'bg-brand-500/10 text-brand-700' : 'text-ink-400 hover:bg-ink-100 hover:text-ink-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
