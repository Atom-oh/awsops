import Card from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import type { HighlightCard } from '@/lib/inventory-types';

/**
 * RiskHero — the lead band for security-posture inventory types (IAM users,
 * S3 public access, CloudTrail). A left accent bar (emerald when clean, rose
 * when there are issues) + a verdict ("정상" / "주의 N건") + the highlight
 * counts as larger cards, danger ones tinted rose. Replaces the generic KPI
 * row for `risk` archetype pages so the security story leads.
 */
export default function RiskHero({ label, total, cards }: { label: string; total: number; cards: HighlightCard[] }) {
  const issues = cards
    .filter((c) => c.variant === 'danger' && typeof c.value === 'number')
    .reduce((s, c) => s + (c.value as number), 0);
  const ok = issues === 0;

  return (
    <Card className={cn('border-l-4', ok ? 'border-l-emerald-400' : 'border-l-rose-400')}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="shrink-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{label} · 보안 상태</div>
          <div className={cn('mt-1 text-[24px] font-semibold leading-none', ok ? 'text-emerald-600' : 'text-rose-600')}>
            {ok ? '정상' : `주의 ${issues.toLocaleString()}건`}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-400">
            총 {total.toLocaleString()}개 · {ok ? '위험 신호 없음' : '아래 위험 항목 확인'}
          </div>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:max-w-2xl lg:grid-cols-4">
          {cards.map((c) => {
            const hot = c.variant === 'danger' && c.value !== 0;
            return (
              <div key={c.label} className={cn('rounded-lg border px-3 py-2.5', hot ? 'border-rose-200 bg-rose-50' : 'border-ink-100 bg-card')}>
                <div className="truncate text-[11px] text-ink-400">{c.label}</div>
                <div className={cn('tabular mt-0.5 text-[20px] font-semibold leading-none', hot ? 'text-rose-700' : c.variant === 'accent' ? 'text-brand-700' : 'text-ink-800')}>
                  {c.value}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
