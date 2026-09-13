'use client';
import { useI18n } from '@/components/shell/LanguageProvider';

interface Props {
  resource: string;
  allocated: number | null;
  usage?: number | null;
  allocatable: number;
  unit: 'cpu' | 'memory';
  usageTimestamp?: string | null;
  usageUnsupported?: boolean;
}

const valid = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const memory = (mib: number) => mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;

/** Requests and measured usage are independent; both ratios use node allocatable. */
export default function NodeResourceMeters({ resource, allocated, usage, allocatable, unit, usageTimestamp, usageUnsupported = false }: Props) {
  const { tt } = useI18n();
  const denominator = valid(allocatable) && allocatable > 0 ? allocatable : null;
  const format = (value: number) => unit === 'cpu' ? value.toFixed(2) : memory(value);
  const readings = [
    { label: 'Allocated', value: allocated, color: 'bg-brand-500' },
    { label: 'Usage', value: usage, color: 'bg-emerald-500' },
  ];
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-[11px] font-semibold text-ink-600">{resource}</div>
      {readings.map(({ label, value, color }) => {
        const known = valid(value);
        const ratio = known && denominator != null ? value / denominator * 100 : null;
        const amount = known
          ? `${format(value)} / ${denominator == null ? '—' : format(denominator)}${unit === 'cpu' ? ' vCPU' : ''}${ratio == null ? '' : ` (${Math.round(ratio)}%)`}`
          : label === 'Usage' ? tt(usageUnsupported ? '미지원' : '미수집') : '—';
        return (
          <div key={label} title={label === 'Usage' && usageTimestamp ? `Metrics API · ${usageTimestamp}` : undefined}>
            <div className="mb-0.5 flex flex-wrap items-baseline justify-between gap-x-2 text-[10.5px]">
              <span className="text-ink-500">{label}</span>
              <span className="tabular text-ink-600">{amount}</span>
            </div>
            {ratio == null ? (
              <div className="h-1.5 rounded-full bg-ink-100" />
            ) : (
              <div role="meter" aria-label={`${resource} ${label}`} aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.min(100, ratio)} aria-valuetext={amount}
                className="h-1.5 overflow-hidden rounded-full bg-ink-100">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, ratio)}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
