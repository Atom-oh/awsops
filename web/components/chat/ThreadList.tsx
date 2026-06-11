'use client';
import type { ThreadSummary } from '@/lib/chat-store';

// Claude-app-style left sidebar: "+ new chat" on top, thread list below,
// active thread highlighted, switching is a single click and keeps the panel open.
export default function ThreadList({ threads, activeId, onSelect, onDelete, onNew }: {
  threads: ThreadSummary[]; activeId: string | null;
  onSelect: (id: string) => void; onDelete: (id: string) => void; onNew: () => void;
}) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0c1322' }}>
      <div style={{ padding: 8 }}>
        <button onClick={onNew} aria-label="새 대화"
          style={{ width: '100%', padding: '7px 10px', borderRadius: 8, cursor: 'pointer', background: '#1d3350', border: '1px solid #2a4368', color: '#dcebff', fontSize: 12, fontWeight: 600, textAlign: 'left' }}>
          ＋ 새 대화
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
        {threads.length === 0 && <div style={{ color: '#7da2c9', fontSize: 11.5, padding: '8px 4px' }}>저장된 대화가 없습니다.</div>}
        {threads.map((t) => (
          <div key={t.id} onClick={() => onSelect(t.id)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '7px 8px', borderRadius: 7, cursor: 'pointer', background: t.id === activeId ? '#1d3350' : 'transparent', marginBottom: 2 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: t.id === activeId ? '#dcebff' : '#bcd6f2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
              <div style={{ fontSize: 9.5, color: '#7da2c9' }}>{new Date(t.updatedAt).toLocaleString()}</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onDelete(t.id); }} aria-label={`${t.title} 삭제`}
              style={{ background: 'none', border: 'none', color: '#5a708c', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}
