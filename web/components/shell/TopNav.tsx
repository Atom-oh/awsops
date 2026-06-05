'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/eks', label: 'EKS' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/cost', label: 'Cost' },
];

export default function TopNav() {
  const path = usePathname();
  return (
    <header style={{ height: 48, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', background: '#0f1629', borderBottom: '1px solid #1a2540', color: '#7da2c9', fontSize: 13 }}>
      <span style={{ color: '#00d4ff', fontWeight: 700 }}>AWSops</span>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} style={{ color: path === l.href ? '#e6eefb' : '#7da2c9', textDecoration: 'none', fontWeight: path === l.href ? 600 : 400 }}>{l.label}</Link>
      ))}
      <span style={{ marginLeft: 'auto' }}>◷ admin</span>
    </header>
  );
}
