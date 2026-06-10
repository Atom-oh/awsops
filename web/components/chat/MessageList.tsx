'use client';
import { sectionByKey } from '@/lib/sections';

export interface RankedChip { key: string; score: number; active: boolean }
export interface Msg {
  role: 'user' | 'assistant'; content: string; gateway?: string; streaming?: boolean;
  ranked?: RankedChip[]; method?: string; // ADR-038 meta
}

export default function MessageList({ msgs, onSwitch }: { msgs: Msg[]; onSwitch?: (key: string) => void }) {
  return (
    <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 9, overflowY: 'auto' }}>
      {msgs.map((m, i) => {
        const sec = m.gateway ? sectionByKey(m.gateway) : null;
        const me = m.role === 'user';
        // ADR-038: active alternates (not the gateway actually used), shown once streaming ends.
        const alts = (!me && !m.streaming && m.ranked)
          ? m.ranked.filter((r) => r.active && r.key !== m.gateway).slice(0, 2)
          : [];
        return (
          <div key={i} style={{ alignSelf: me ? 'flex-end' : 'flex-start', maxWidth: '88%', background: me ? '#1d3350' : '#12203a', border: me ? 'none' : '1px solid #21314e', borderRadius: 10, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5, color: me ? '#dcebff' : '#bcd6f2' }}>
            {sec && (
              <div style={{ fontSize: 9.5, color: sec.color, marginBottom: 5 }}>{sec.icon} {sec.label}</div>
            )}
            <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
            {m.streaming && <span style={{ display: 'inline-block', width: 7, height: 13, background: '#00d4ff', marginLeft: 2, verticalAlign: -2 }} />}
            {alts.length > 0 && (
              <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                {alts.map((r) => {
                  const s = sectionByKey(r.key);
                  if (!s) return null;
                  return (
                    <button key={r.key} onClick={() => onSwitch?.(r.key)} aria-label={`${s.label}로 다시`}
                      style={{ fontSize: 10.5, padding: '3px 8px', borderRadius: 7, cursor: 'pointer', background: `${s.color}14`, border: `1px solid ${s.color}55`, color: '#cfe3fb' }}>
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
