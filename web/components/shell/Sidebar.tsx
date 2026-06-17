'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  SearchCode,
  LayoutDashboard, MessagesSquare, Activity, DollarSign, Sparkles,
  Box, Gauge,
  Server, Zap, Container, Package,
  Archive, HardDrive, Database, Table, DatabaseZap, Search, Radio,
  Network, Waypoints, BrickWall, Globe, Scale, Split, Webhook, Cable, CloudCog, Route, ListFilter,
  KeyRound, Users, Shield, FileSearch, Bell,
  Stethoscope, // /ai-diagnosis nav (this branch)
  type LucideIcon,
} from 'lucide-react';
import { INVENTORY_TYPES, inventoryGroups } from '@/lib/inventory-types';
import AwsopsMark from '@/components/ui/AwsopsMark';
import SectionLabel from '@/components/ui/SectionLabel';
import { useI18n } from '@/components/shell/LanguageProvider';
import LanguageToggle from '@/components/shell/LanguageToggle';
import UserIdentity from '@/components/shell/UserIdentity';
import ThemeToggle from '@/components/shell/ThemeToggle';
import { cn } from '@/lib/cn';

// Fixed top-level pages. `tkey` resolves the label via i18n.
const FIXED: { href: string; tkey: string; icon: LucideIcon }[] = [
  { href: '/', tkey: 'nav.overview', icon: LayoutDashboard },
  { href: '/ai-diagnosis', tkey: 'nav.aiDiagnosis', icon: Stethoscope },
  { href: '/assistant', tkey: 'nav.assistant', icon: MessagesSquare },
  { href: '/jobs', tkey: 'nav.jobs', icon: Activity },
  { href: '/cost', tkey: 'nav.cost', icon: DollarSign },
  { href: '/bedrock', tkey: 'nav.bedrock', icon: Gauge },
  { href: '/topology', tkey: 'nav.topology', icon: Network },
  { href: '/security', tkey: 'nav.security', icon: Shield },
  { href: '/customization', tkey: 'nav.customAgents', icon: Sparkles },
  { href: '/datasources', tkey: 'nav.datasources', icon: SearchCode },
];

// One distinct lucide icon per inventory type (keyed by the registry slug).
// Mirrors v1's per-resource icons; v2-only types (subnet/SG/ALB/NLB/roles) get their own.
const TYPE_ICON: Record<string, LucideIcon> = {
  // Compute
  ec2: Server,
  lambda: Zap,
  ecs_cluster: Container,
  ecr: Package,
  // Storage & DB
  s3: Archive,
  ebs_volume: HardDrive,
  rds: Database,
  dynamodb: Table,
  elasticache: DatabaseZap,
  opensearch: Search,
  msk: Radio,
  // Network
  vpc: Network,
  subnet: Waypoints,
  security_group: BrickWall,
  cloudfront: Globe,
  alb: Scale,
  nlb: Split,
  apigatewayv2_api: Webhook,
  apigatewayv2_integration: Cable,
  cloudfront_vpc_origin: CloudCog,
  apigatewayv2_route: Route,
  alb_listener_rule: ListFilter,
  // Security
  iam_role: KeyRound,
  iam_user: Users,
  waf: Shield,
  cloudtrail: FileSearch,
  // Monitoring
  cloudwatch_alarm: Bell,
};

function NavItem({ href, label, icon: Icon, active, className, onNavigate }: { href: string; label: string; icon: LucideIcon; active: boolean; className?: string; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium no-underline transition-colors duration-[120ms]',
        active
          ? 'bg-chrome-active text-chrome-active-fg shadow-sm'
          : 'text-chrome-fg-muted hover:bg-chrome-active/40 hover:text-chrome-fg',
        className,
      )}
    >
      <Icon size={16} strokeWidth={1.7} className={cn('shrink-0', active ? 'text-chrome-active-fg' : 'text-chrome-fg-muted')} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

// `onNavigate` lets a host (e.g. the mobile drawer) close itself when a link is
// tapped; `className` lets a host add layout classes (e.g. `hidden lg:flex`).
// With no props passed the desktop sidebar renders identically to before.
export default function Sidebar({ onNavigate, className }: { onNavigate?: () => void; className?: string } = {}) {
  const path = usePathname();
  const groups = inventoryGroups();
  const { t } = useI18n();

  return (
    <aside
      className={cn(
        'flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-chrome-border bg-chrome-muted px-4 pb-4 pt-[22px] backdrop-blur',
        className,
      )}
    >
      {/* Lockup */}
      <div className="mb-5 flex items-center gap-2.5">
        <AwsopsMark size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-chrome-fg">AWSops</div>
          <div className="text-[10px] text-chrome-fg-muted">{t('sidebar.tagline')}</div>
        </div>
        <LanguageToggle />
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-4">
        <div className="space-y-0.5">
          {FIXED.map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              label={t(item.tkey)}
              icon={item.icon}
              active={path === item.href}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        {groups.map((g) => (
          <div key={g.group} className="space-y-0.5">
            <SectionLabel className="px-2.5 pb-1 text-[11px] tracking-[0.04em] text-chrome-fg-muted">{g.group}</SectionLabel>
            {g.group === 'Compute' && (
              /* EKS keeps its own route/icon but lives under Compute (user feedback).
                 OpenCost now lives per-cluster on the EKS detail page, not as a nav item. */
              <NavItem href="/eks" label="EKS" icon={Box} active={path === '/eks' || path.startsWith('/eks/')} onNavigate={onNavigate} />
            )}
            {g.types.map((ty) => {
              const href = `/inventory/${ty}`;
              return (
                <NavItem
                  key={ty}
                  href={href}
                  label={INVENTORY_TYPES[ty].label}
                  icon={TYPE_ICON[ty] ?? Server}
                  active={path === href}
                  onNavigate={onNavigate}
                />
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="mt-4 border-t border-chrome-border pt-3">
        <UserIdentity />
        <div className="mt-2 flex items-center gap-1.5 px-0.5 text-[11px] text-chrome-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          <span>{t('sidebar.statusLine', { status: t('sidebar.online') })}</span>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
