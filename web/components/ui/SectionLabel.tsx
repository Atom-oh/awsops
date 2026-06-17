import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * SectionLabel — uppercase eyebrow heading above a KPI group / section.
 * 11px, tracking 0.04em, ink-400, semibold.
 */
export default function SectionLabel({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={cn('text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400', className)}>
      {children}
    </div>
  );
}
