'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Box, Activity, DollarSign,
  Server, Database, Network, ShieldCheck,
  Sparkles, Gauge,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { INVENTORY_TYPES, inventoryGroups } from '@/lib/inventory-types';
import AwsopsMark from '@/components/ui/AwsopsMark';
import Badge from '@/components/ui/Badge';
import SectionLabel from '@/components/ui/SectionLabel';
import { cn } from '@/lib/cn';

// Fixed top-level pages.
const FIXED: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/eks', label: 'EKS', icon: Box },
  { href: '/jobs', label: 'Jobs', icon: Activity },
  { href: '/cost', label: 'Cost', icon: DollarSign },
  { href: '/bedrock', label: 'Bedrock', icon: Gauge },
  { href: '/customization', label: 'Custom Agents', icon: Sparkles },
];

// One lucide icon per inventory group.
const GROUP_ICON: Record<string, LucideIcon> = {
  Compute: Server,
  'Storage & DB': Database,
  Network: Network,
  Security: ShieldCheck,
  Monitoring: Activity,
};

function NavItem({ href, label, icon: Icon, active }: { href: string; label: string; icon: LucideIcon; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium no-underline transition-colors duration-[120ms]',
        active
          ? 'bg-claude-500 text-white shadow-sm'
          : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800',
      )}
    >
      <Icon size={16} strokeWidth={1.7} className={cn('shrink-0', active ? 'text-white' : 'text-ink-400')} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

export default function Sidebar() {
  const path = usePathname();
  const groups = inventoryGroups();

  return (
    <aside
      className="flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-ink-100 bg-paper-muted/60 px-4 pb-4 pt-[22px] backdrop-blur"
    >
      {/* Lockup */}
      <div className="mb-5 flex items-center gap-2.5">
        <AwsopsMark size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-ink-800">AWSops</div>
          <div className="text-[10px] text-ink-400">Cloud Operations</div>
        </div>
        <Badge tone="brand" variant="soft">v2.0</Badge>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-4">
        <div className="space-y-0.5">
          {FIXED.map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={path === item.href}
            />
          ))}
        </div>

        {groups.map((g) => {
          const Icon = GROUP_ICON[g.group] ?? Server;
          return (
            <div key={g.group} className="space-y-0.5">
              <SectionLabel className="px-2.5 pb-1 text-[11px] tracking-[0.04em] text-ink-400">{g.group}</SectionLabel>
              {g.types.map((t) => {
                const href = `/inventory/${t}`;
                return (
                  <NavItem
                    key={t}
                    href={href}
                    label={INVENTORY_TYPES[t].label}
                    icon={Icon}
                    active={path === href}
                  />
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="mt-4 border-t border-ink-100 pt-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-ink-800 text-[13px] font-semibold text-paper">
            관
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-tight text-ink-800">관리자</div>
            <div className="truncate font-mono text-[11px] text-ink-400">ad*****@awsops.io</div>
          </div>
          <button
            type="button"
            aria-label="로그아웃"
            className="rounded-md p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-800"
          >
            <LogOut size={16} strokeWidth={1.7} />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-1.5 px-0.5 text-[11px] text-ink-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span>ap-northeast-2 · 온라인</span>
        </div>
      </div>
    </aside>
  );
}
