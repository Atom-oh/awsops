'use client';
import { useState } from 'react';
import { ArrowUp } from 'lucide-react';

export default function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const send = () => { const t = text.trim(); if (t && !disabled) { onSend(t); setText(''); } };
  return (
    <div className="flex items-center gap-2 border-t border-ink-100 px-3 py-3">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="메시지를 입력하세요…"
        disabled={disabled}
        className="h-9 flex-1 rounded-lg border border-ink-200 bg-card px-3 text-[13px] text-ink-800 placeholder:text-ink-400 outline-none transition-shadow focus:border-brand-300 focus:shadow-focus disabled:opacity-60"
      />
      <button
        onClick={send}
        disabled={disabled}
        aria-label="보내기"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500 text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
      >
        <ArrowUp size={17} strokeWidth={2.4} />
      </button>
    </div>
  );
}
