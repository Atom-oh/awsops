'use client';
import { useState } from 'react';

export default function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const send = () => { const t = text.trim(); if (t && !disabled) { onSend(t); setText(''); } };
  return (
    <div style={{ padding: '10px 12px', borderTop: '1px solid #1a2540', display: 'flex', gap: 7 }}>
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="메시지를 입력하세요…" disabled={disabled}
        style={{ flex: 1, height: 32, background: '#0a0e1a', border: '1px solid #2a3a5c', borderRadius: 8, color: '#e6eefb', padding: '0 10px' }} />
      <button onClick={send} disabled={disabled} style={{ width: 32, height: 32, borderRadius: 8, background: '#00d4ff', color: '#06121f', border: 'none', fontWeight: 800, cursor: 'pointer' }}>➤</button>
    </div>
  );
}
