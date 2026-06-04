export default function TopNav() {
  return (
    <header style={{ height: 48, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', background: '#0f1629', borderBottom: '1px solid #1a2540', color: '#7da2c9', fontSize: 13 }}>
      <span style={{ color: '#00d4ff', fontWeight: 700 }}>AWSops</span>
      <span>Overview</span>
      <span style={{ marginLeft: 'auto' }}>◷ admin</span>
    </header>
  );
}
