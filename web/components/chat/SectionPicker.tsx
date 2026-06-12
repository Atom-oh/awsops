'use client';
import { Compass } from 'lucide-react';
import { SECTIONS } from '@/lib/sections';

export default function SectionPicker({ pinned, onPin }: { pinned: string | null; onPin: (key: string | null) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-ink-100 px-3 py-2.5">
      <button
        onClick={() => onPin(null)}
        title="자동 라우팅"
        aria-label="자동 라우팅"
        className={
          'flex h-7 w-7 items-center justify-center rounded-md border transition-colors ' +
          (pinned === null ? 'border-brand-300 bg-brand-50 text-brand-600' : 'border-ink-100 text-ink-400 hover:bg-ink-100')
        }
      >
        <Compass size={15} />
      </button>
      {SECTIONS.map((s) => {
        const on = pinned === s.key;
        return (
          <button
            key={s.key}
            title={s.active ? s.label : `${s.label} (준비중)`}
            aria-label={s.label}
            onClick={() => onPin(s.key)}
            className={'flex h-7 w-7 items-center justify-center rounded-md border text-[14px] transition-colors ' + (s.active ? '' : 'opacity-40')}
            style={on
              ? { background: `${s.color}14`, borderColor: `${s.color}59` }
              : { background: 'transparent', borderColor: 'var(--ink-100)' }}
          >
            {s.icon}
          </button>
        );
      })}
    </div>
  );
}
