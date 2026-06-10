'use client';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import Badge from './Badge';
import StatePill from './StatePill';
import { buildDetailGroups, type DetailValue } from '@/lib/inventory-detail';
import type { InvType } from '@/lib/inventory-types';

/**
 * DetailPanel — right slide-in panel showing EVERY field of a resource row.
 * The inventory/EKS pages already hold the full Steampipe/K8s row in each
 * table row ({resource_id, region, ...data}), so this renders all of it with
 * no extra fetch. Renders nothing when `data` is null. Closes on the × button,
 * an overlay click, or Escape. paper+ink tokens only (reuses Badge from F1).
 *
 * With a `spec` (InvType) carrying `sections`, fields render grouped under
 * section headers with friendly labels; without a spec it stays a flat list
 * of raw keys (backward-compatible).
 */
function renderValue(fmt: DetailValue) {
  switch (fmt.kind) {
    case 'boolean':
      return (
        <Badge tone={fmt.bool ? 'positive' : 'neutral'} variant="soft">
          {fmt.bool ? 'true' : 'false'}
        </Badge>
      );
    case 'empty':
      return <span className="text-ink-300">—</span>;
    case 'code':
      return (
        <pre className="mt-0.5 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-ink-50 p-2 text-[11px] leading-snug text-ink-700">
          {fmt.text}
        </pre>
      );
    case 'state':
      return <StatePill value={fmt.text!} />;
    default:
      return <span className="block break-words text-[13px] text-ink-800 select-text">{fmt.text}</span>;
  }
}

export default function DetailPanel({
  title,
  data,
  spec,
  onClose,
}: {
  title?: string;
  data: Record<string, unknown> | null;
  spec?: InvType;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  if (!data) return null;

  const groups = buildDetailGroups(data, spec);

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink-900/20"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title ?? '리소스 상세'}
        className="fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-full flex-col border-l border-ink-100 bg-white shadow-pop"
      >
        <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <h2 className="min-w-0 break-words font-mono text-[13px] font-semibold text-ink-800">
            {title ?? '리소스 상세'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="-mr-1 shrink-0 rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {groups.map((group, gi) => (
            <section key={group.label || gi}>
              {group.label && (
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-400">
                  {group.label}
                </h3>
              )}
              <dl className="space-y-2.5">
                {group.items.map((it) => (
                  <div key={it.key} className="grid grid-cols-1 gap-0.5">
                    <dt className="font-mono text-[11px] text-ink-500">{it.label}</dt>
                    <dd className="text-[13px] text-ink-800">{renderValue(it.fmt)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}
