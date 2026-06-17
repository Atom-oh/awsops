'use client';
import { Plus, Trash2 } from 'lucide-react';
import type { ThreadSummary } from '@/lib/chat-store';

// Claude-app-style left sidebar: "+ new chat" on top, thread list below,
// active thread highlighted, switching is a single click and keeps the panel open.
export default function ThreadList({ threads, activeId, onSelect, onDelete, onNew }: {
  threads: ThreadSummary[]; activeId: string | null;
  onSelect: (id: string) => void; onDelete: (id: string) => void; onNew: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col bg-paper-muted/60">
      <div className="p-2">
        <button
          onClick={onNew}
          aria-label="새 대화"
          className="flex w-full items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-left text-[13px] font-medium text-brand-700 transition-colors hover:bg-brand-100"
        >
          <Plus size={15} /> 새 대화
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {threads.length === 0 && (
          <div className="px-1.5 py-2 text-[12px] text-ink-400">저장된 대화가 없습니다.</div>
        )}
        {threads.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={
                'group mb-0.5 flex cursor-pointer items-center justify-between gap-1.5 rounded-md px-2 py-2 transition-colors ' +
                (active ? 'bg-card shadow-sm' : 'hover:bg-ink-100/70')
              }
            >
              <div className="min-w-0">
                <div className={'truncate text-[12.5px] ' + (active ? 'font-medium text-ink-800' : 'text-ink-600')}>{t.title}</div>
                <div className="text-[10px] text-ink-400">{new Date(t.updatedAt).toLocaleString()}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
                aria-label={`${t.title} 삭제`}
                className="shrink-0 rounded p-1 text-ink-300 opacity-0 transition-colors hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
