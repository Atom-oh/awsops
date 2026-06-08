'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { INVENTORY_TYPES, inventoryGroups } from '@/lib/inventory-types';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/eks', label: 'EKS' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/cost', label: 'Cost' },
];

export default function TopNav() {
  const path = usePathname();
  const groups = inventoryGroups();
  const inventoryActive = path.startsWith('/inventory/');
  return (
    <header style={{ height: 48, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', background: '#0f1629', borderBottom: '1px solid #1a2540', color: '#7da2c9', fontSize: 13 }}>
      <span style={{ color: '#00d4ff', fontWeight: 700 }}>AWSops</span>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} style={{ color: path === l.href ? '#e6eefb' : '#7da2c9', textDecoration: 'none', fontWeight: path === l.href ? 600 : 400 }}>{l.label}</Link>
      ))}
      <div style={{ position: 'relative' }} className="awsops-inv-nav">
        <span style={{ color: inventoryActive ? '#e6eefb' : '#7da2c9', fontWeight: inventoryActive ? 600 : 400, cursor: 'default' }}>Inventory ▾</span>
        <div className="awsops-inv-menu" style={{ position: 'absolute', top: '100%', left: 0, display: 'none', flexDirection: 'column', gap: 4, padding: 12, background: '#0f1629', border: '1px solid #1a2540', borderRadius: 6, minWidth: 320, zIndex: 50, boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
          {groups.map((g) => (
            <div key={g.group} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ color: '#4f6a8f', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>{g.group}</span>
              {g.types.map((t) => {
                const href = `/inventory/${t}`;
                const active = path === href;
                return (
                  <Link key={t} href={href} style={{ color: active ? '#e6eefb' : '#7da2c9', textDecoration: 'none', fontWeight: active ? 600 : 400, paddingLeft: 8 }}>{INVENTORY_TYPES[t].label}</Link>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <span style={{ marginLeft: 'auto' }}>◷ admin</span>
      <style>{`.awsops-inv-nav:hover .awsops-inv-menu{display:flex !important;}`}</style>
    </header>
  );
}
