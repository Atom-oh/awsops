import type { ReactNode } from 'react';
import Badge from './Badge';
import { cn } from '@/lib/cn';

/**
 * PageHeader — shared page header. Title (xl/600) + optional `live` dot Badge
 * ("실시간", positive) + subtitle (base/secondary, max 680px) + right slot.
 * Bottom hairline. Padding 26px 32px 20px (per DESIGN §3).
 */
export default function PageHeader({
  title,
  subtitle,
  live = false,
  right,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  live?: boolean;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex items-start justify-between gap-4 px-8 pt-[26px] pb-5 border-b border-ink-100', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-ink-800 leading-tight">{title}</h1>
          {live && (
            <Badge tone="positive" variant="soft" dot>
              실시간
            </Badge>
          )}
        </div>
        {subtitle != null && <p className="text-[14px] text-ink-500 mt-1.5 max-w-[680px]">{subtitle}</p>}
      </div>
      {right != null && <div className="flex items-center gap-3 shrink-0">{right}</div>}
    </header>
  );
}
