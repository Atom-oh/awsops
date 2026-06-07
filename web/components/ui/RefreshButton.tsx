'use client';
export default function RefreshButton({ busy, onClick, capturedAt }: { busy: boolean; onClick: () => void; capturedAt?: string | null }) {
  const age = capturedAt ? `업데이트: ${new Date(capturedAt).toLocaleString('ko-KR')}` : '미수집';
  const stale = capturedAt ? Date.now() - new Date(capturedAt).getTime() > 30 * 60 * 1000 : false;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <button onClick={onClick} disabled={busy} style={{ height: 30, padding: '0 12px', borderRadius: 8, background: '#00d4ff', color: '#06121f', border: 'none', fontWeight: 700, cursor: 'pointer' }}>
        {busy ? '수집 중…' : '↻ Refresh'}
      </button>
      <span style={{ fontSize: 11, color: stale ? '#f59e0b' : '#7da2c9' }}>{age}{stale ? ' (오래됨)' : ''}</span>
    </div>
  );
}
