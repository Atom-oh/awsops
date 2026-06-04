'use client';
import { sectionByKey } from '@/lib/sections';

export interface Msg { role: 'user' | 'assistant'; content: string; gateway?: string; streaming?: boolean }

export default function MessageList({ msgs }: { msgs: Msg[] }) {
  return (
    <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 9, overflowY: 'auto' }}>
      {msgs.map((m, i) => {
        const sec = m.gateway ? sectionByKey(m.gateway) : null;
        const me = m.role === 'user';
        return (
          <div key={i} style={{ alignSelf: me ? 'flex-end' : 'flex-start', maxWidth: '88%', background: me ? '#1d3350' : '#12203a', border: me ? 'none' : '1px solid #21314e', borderRadius: 10, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5, color: me ? '#dcebff' : '#bcd6f2' }}>
            {sec && (
              <div style={{ fontSize: 9.5, color: sec.color, marginBottom: 5 }}>{sec.icon} {sec.label}</div>
            )}
            <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
            {m.streaming && <span style={{ display: 'inline-block', width: 7, height: 13, background: '#00d4ff', marginLeft: 2, verticalAlign: -2 }} />}
          </div>
        );
      })}
    </div>
  );
}
