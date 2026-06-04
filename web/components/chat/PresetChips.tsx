'use client';
import { sectionByKey, AUTO_PRESETS } from '@/lib/sections';

export default function PresetChips({ pinned, onPick }: { pinned: string | null; onPick: (q: string) => void }) {
  const sec = pinned ? sectionByKey(pinned) : null;
  const prompts = sec ? sec.presets : AUTO_PRESETS;
  const head = sec ? `${sec.icon} ${sec.label} — 무엇을 도와드릴까요?` : '무엇을 도와드릴까요?';
  return (
    <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ fontSize: 12.5, color: '#9db8d8', textAlign: 'center', marginBottom: 4 }}>{head}</div>
      {prompts.map((p) => (
        <button key={p} onClick={() => onPick(p)} style={{ fontSize: 12, color: '#dcebff', background: '#13233b', border: '1px solid #2a3f60', borderRadius: 18, padding: '8px 12px', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ color: '#f59e0b', marginRight: 6 }}>▸</span>{p}
        </button>
      ))}
    </div>
  );
}
