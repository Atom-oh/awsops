'use client';
import { sectionByKey, AUTO_PRESETS } from '@/lib/sections';

export default function PresetChips({ pinned, onPick }: { pinned: string | null; onPick: (q: string) => void }) {
  const sec = pinned ? sectionByKey(pinned) : null;
  const prompts = sec ? sec.presets : AUTO_PRESETS;
  const head = sec ? `${sec.icon} ${sec.label} — 무엇을 도와드릴까요?` : '무엇을 도와드릴까요?';
  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4">
      <div className="mb-1 text-center text-[13px] text-ink-500">{head}</div>
      {prompts.map((p) => (
        <button
          key={p}
          onClick={() => onPick(p)}
          className="rounded-xl border border-ink-100 bg-card px-3.5 py-2.5 text-left text-[13px] text-ink-700 shadow-sm transition-colors hover:border-brand-200 hover:bg-brand-50"
        >
          <span className="mr-1.5 text-brand-500">▸</span>{p}
        </button>
      ))}
    </div>
  );
}
