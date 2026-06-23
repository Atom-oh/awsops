'use client';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useResizablePanel, RESIZE_GRIP_CLASS, RESIZE_GRIP_BAR_CLASS } from '@/lib/useResizablePanel';
import { X } from 'lucide-react';
import Badge from './Badge';
import StatePill from './StatePill';
import { buildDetailGroups, type DetailValue } from '@/lib/inventory-detail';
import type { InvType } from '@/lib/inventory-types';
import type { RdsInstanceMetrics } from '@/lib/metrics';

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

// RDS detail panels show a live per-instance CloudWatch metrics table (v1 parity). Metrics are NOT in the
// synced inventory row, so this fetches them on open (read-only) and degrades to a "메트릭 불가" note.
const RDS_METRIC_ROWS: { key: keyof RdsInstanceMetrics; label: string; fmt: (v: number) => string }[] = [
  { key: 'cpu', label: 'CPU', fmt: (v) => `${v}%` },
  { key: 'connections', label: 'DB 커넥션', fmt: (v) => `${v}` },
  { key: 'freeableMemory', label: '여유 메모리', fmt: (v) => `${(v / 1e6).toFixed(0)} MB` },
  { key: 'freeStorage', label: '여유 스토리지', fmt: (v) => `${(v / 1e9).toFixed(1)} GB` },
  { key: 'readIops', label: 'Read IOPS', fmt: (v) => `${v}` },
  { key: 'writeIops', label: 'Write IOPS', fmt: (v) => `${v}` },
  { key: 'netIn', label: 'Network In', fmt: (v) => `${(v / 1024).toFixed(1)} KB/s` },
  { key: 'netOut', label: 'Network Out', fmt: (v) => `${(v / 1024).toFixed(1)} KB/s` },
];

function RdsMetricsSection({ instanceId }: { instanceId: string }) {
  const [s, setS] = useState<{ loading: boolean; metrics: RdsInstanceMetrics | null; error: boolean }>({
    loading: true, metrics: null, error: false,
  });
  useEffect(() => {
    let alive = true;
    setS({ loading: true, metrics: null, error: false });
    fetch(`/api/inventory/rds/metrics?id=${encodeURIComponent(instanceId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setS({ loading: false, metrics: (d.instance ?? null) as RdsInstanceMetrics | null, error: false }); })
      .catch(() => { if (alive) setS({ loading: false, metrics: null, error: true }); });
    return () => { alive = false; };
  }, [instanceId]);

  return (
    <section className="border-t border-ink-100 pt-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-400">
        인스턴스 메트릭 (CloudWatch)
      </h3>
      {s.loading ? (
        <p className="text-[12px] text-ink-400">메트릭 로딩 중…</p>
      ) : s.error || !s.metrics ? (
        <p className="text-[12px] text-ink-300">메트릭 불가</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {RDS_METRIC_ROWS.map((row) => {
            const v = s.metrics![row.key];
            return (
              <div key={row.key} className="flex flex-col gap-0.5">
                <dt className="font-mono text-[11px] text-ink-500">{row.label}</dt>
                <dd className="text-[13px] text-ink-800">
                  {typeof v === 'number' ? row.fmt(v) : <span className="text-ink-300">—</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

export default function DetailPanel({
  title,
  data,
  spec,
  resourceType,
  onClose,
  actions,
  children,
  modal = true,
}: {
  title?: string;
  data: Record<string, unknown> | null;
  spec?: InvType;
  resourceType?: string; // inventory resource type (e.g. 'rds') — enables type-specific live metric sections
  onClose: () => void;
  // optional action slot pinned under the header (e.g. topology "ask AI about this resource").
  actions?: ReactNode;
  // optional extra detail sections rendered after the field list.
  children?: ReactNode;
  // modal=false: on lg the backdrop is transparent + pointer-events-none so the content behind
  // (e.g. the topology canvas) stays pannable/zoomable while the panel is docked. Mobile (below
  // lg) is always a fullscreen sheet, so it stays modal there regardless.
  modal?: boolean;
}) {
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  // Right-docked panels are user-resizable by default (drag the left edge; persisted).
  const { width, startResize } = useResizablePanel('awsops_detail_width', 480);

  // Publish the docked width to a root CSS var so the globally-mounted chat (ShellGate's
  // ChatDrawer/FAB, also right-edge anchored) can offset left and not overlap this panel.
  // 0 when closed → chat returns to its default right edge. lg-only consumers; harmless below.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--detail-panel-w', data ? `${width}px` : '0px');
    return () => { root.style.setProperty('--detail-panel-w', '0px'); };
  }, [data, width]);

  if (!data) return null;

  const groups = buildDetailGroups(data, spec);
  const rdsInstanceId = resourceType === 'rds' && typeof data.resource_id === 'string' ? data.resource_id : null;

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={
          modal
            ? 'fixed inset-0 z-40 bg-ink-900/40 lg:bg-ink-900/20'
            : 'fixed inset-0 z-40 bg-ink-900/40 lg:bg-transparent lg:pointer-events-none'
        }
      />
      {/* Below lg: fullscreen sheet (inset-0, full width, no left border).
          lg+: unchanged right-docked panel (420px, border-l). CSS-only switch. */}
      <aside
        role="dialog"
        aria-modal={modal}
        aria-label={title ?? '리소스 상세'}
        className="fixed inset-0 z-50 flex h-full w-full max-w-full flex-col bg-card shadow-pop lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[var(--panel-w)] lg:border-l lg:border-ink-100"
        style={{ ['--panel-w' as string]: `${width}px` } as CSSProperties}
      >
        <div onMouseDown={startResize} title="드래그하여 폭 조절" aria-label="패널 폭 조절" role="separator" className={`${RESIZE_GRIP_CLASS} hidden lg:block`}>
          <div className={RESIZE_GRIP_BAR_CLASS} />
        </div>
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
        {actions && <div className="border-b border-ink-100 px-4 py-3">{actions}</div>}
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
          {rdsInstanceId && <RdsMetricsSection instanceId={rdsInstanceId} />}
          {children}
        </div>
      </aside>
    </>
  );
}
