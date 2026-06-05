export default function StatCard({ label, value, accent = '#00d4ff' }: { label: string; value: string | number; accent?: string }) {
  return (
    <div style={{ background: '#0f1629', border: '1px solid #1a2540', borderLeft: `3px solid ${accent}`, borderRadius: 8, padding: '14px 16px', minWidth: 160 }}>
      <div style={{ fontSize: 11, color: '#7da2c9', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 24, color: '#e6eefb', fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}
