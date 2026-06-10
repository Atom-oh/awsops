'use client';
import type { ThreadSummary } from '@/lib/chat-store';

export default function ThreadList({ threads, activeId, onSelect, onDelete, onClose }: {
  threads: ThreadSummary[]; activeId: string | null;
  onSelect: (id: string) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0f1629f2', zIndex: 5, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #1a2540', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>대화 목록</span>
        <button onClick={onClose} aria-label="목록 닫기" style={{ background: 'none', border: 'none', color: '#7da2c9', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {threads.length === 0 && <div style={{ color: '#7da2c9', fontSize: 12, padding: 12 }}>저장된 대화가 없습니다.</div>}
        {threads.map((t) => (
          <div key={t.id} onClick={() => onSelect(t.id)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: t.id === activeId ? '#1d3350' : 'transparent', border: '1px solid #21314e', marginBottom: 6 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: '#dcebff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
              <div style={{ fontSize: 10, color: '#7da2c9' }}>{new Date(t.updatedAt).toLocaleString()}</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onDelete(t.id); }} aria-label={`${t.title} 삭제`}
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 13 }}>🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}
