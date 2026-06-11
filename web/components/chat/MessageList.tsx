'use client';
import { sectionByKey } from '@/lib/sections';
import Markdown from './Markdown';

export interface RankedChip { key: string; score: number; active: boolean }
export interface Msg {
  role: 'user' | 'assistant'; content: string; gateway?: string; streaming?: boolean;
  ranked?: RankedChip[]; method?: string; // ADR-038 meta
}

export default function MessageList({ msgs, onSwitch }: { msgs: Msg[]; onSwitch?: (key: string) => void }) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {msgs.map((m, i) => {
        const sec = m.gateway ? sectionByKey(m.gateway) : null;
        const me = m.role === 'user';
        // ADR-038: active alternates (not the gateway actually used), shown once streaming ends.
        const alts = (!me && !m.streaming && m.ranked)
          ? m.ranked.filter((r) => r.active && r.key !== m.gateway).slice(0, 2)
          : [];
        return (
          <div
            key={i}
            className={
              'rounded-lg px-3 py-2.5 ' +
              (me
                ? 'max-w-[85%] self-end border border-claude-100 bg-claude-50 text-ink-800'
                : 'max-w-[92%] self-start border border-ink-100 bg-white text-ink-700 shadow-sm')
            }
          >
            {sec && (
              <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold" style={{ color: sec.color }}>
                <span>{sec.icon}</span> {sec.label}
              </div>
            )}
            {/* Plain text for user messages AND while the assistant is still streaming —
                rendering Markdown per token re-parses the whole tree (O(n²)) and flashes
                half-built tables. Switch to Markdown once the stream settles. */}
            {me || m.streaming
              ? <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{m.content}</div>
              : <Markdown>{m.content}</Markdown>}
            {m.streaming && <span className="ml-0.5 inline-block h-3 w-[6px] translate-y-0.5 animate-pulse bg-claude-500 align-middle" />}
            {alts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {alts.map((r) => {
                  const s = sectionByKey(r.key);
                  if (!s) return null;
                  return (
                    <button
                      key={r.key}
                      onClick={() => onSwitch?.(r.key)}
                      aria-label={`${s.label}로 다시`}
                      className="rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
                      style={{ background: `${s.color}12`, borderColor: `${s.color}40`, color: s.color }}
                    >
                      → {s.icon} {s.label}로 다시
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
