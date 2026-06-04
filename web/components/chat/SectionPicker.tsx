'use client';
import { SECTIONS } from '@/lib/sections';

export default function SectionPicker({ pinned, onPin }: { pinned: string | null; onPin: (key: string | null) => void }) {
  return (
    <div style={{ display: 'flex', gap: 5, padding: '8px 12px', borderBottom: '1px solid #1a2540', flexWrap: 'wrap' }}>
      <button onClick={() => onPin(null)} title="Auto" style={chip(pinned === null, '#00d4ff')}>🧭</button>
      {SECTIONS.map((s) => (
        <button key={s.key} title={s.active ? s.label : `${s.label} (준비중)`}
          onClick={() => onPin(s.key)} style={{ ...chip(pinned === s.key, s.color), opacity: s.active ? 1 : 0.4 }}>
          {s.icon}
        </button>
      ))}
    </div>
  );
}
function chip(on: boolean, color: string): React.CSSProperties {
  return { width: 28, height: 28, borderRadius: 7, fontSize: 14, cursor: 'pointer',
    background: on ? `${color}1a` : '#0a0e1a', border: `1px solid ${on ? color : '#21314e'}`, color: '#e6eefb' };
}
