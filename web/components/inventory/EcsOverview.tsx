'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import SectionLabel from '@/components/ui/SectionLabel';
import StatTile from '@/components/ui/StatTile';
import Card from '@/components/ui/Card';
import StatePill from '@/components/ui/StatePill';
import { useI18n } from '@/components/shell/LanguageProvider';

// ECS unified overview (gap L216, v1 parity): summary KPI + clusters table + services table on
// ONE screen. Read-only glance layer — search/facets/detail stay on the per-type pages (linked
// from each table header); this page deliberately does not wire DetailPanel.
// Honesty contract (repo conventions):
// - a >=500-row page is a SAMPLE: tables carry `(표본 기준)` and the service-task rollup tiles
//   are suppressed (a sample sum must not read as a fleet-wide truth);
// - each type's last sync-run status rides the existing {rows, run} API contract — a
//   non-succeeded run renders a stale-data caption on that table;
// - pre-sync (no rows AND no run) reads "미수집", never a fabricated empty fleet.

const ROW_CAP = 500;

type Run = { status?: string; finished_at?: string | null; last_success_at?: string | null } | null;
type Row = { resource_id: string; region: string; account_id: string; data?: Record<string, unknown> };
interface TypeState { rows: Row[]; run: Run; err: boolean; loaded: boolean }

const EMPTY: TypeState = { rows: [], run: null, err: false, loaded: false };

function d(r: Row, key: string): unknown { return r.data?.[key]; }
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0; }
/** Cluster display name from an ECS cluster ARN ("arn:...:cluster/name" → "name"). */
export function clusterLeaf(arn: unknown): string {
  const s = String(arn ?? '');
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s || '—';
}

export default function EcsOverview() {
  const { tt } = useI18n();
  const [clusters, setClusters] = useState<TypeState>(EMPTY);
  const [services, setServices] = useState<TypeState>(EMPTY);
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const fetchType = async (type: string, set: (s: TypeState) => void) => {
      try {
        const r = await fetch(`/api/inventory/${type}?limit=${ROW_CAP}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        set({ rows: j.rows ?? [], run: j.run ?? null, err: false, loaded: true });
      } catch {
        set({ ...EMPTY, err: true, loaded: true });
      }
    };
    await Promise.allSettled([
      fetchType('ecs_cluster', setClusters),
      fetchType('ecs_service', setServices),
      // task COUNT from the shared summary (the tasks table itself stays on its type page)
      fetch('/api/inventory/summary')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => setTaskCount(Number((j.byType ?? []).find((x: { type: string }) => x.type === 'ecs_task')?.count ?? 0)))
        .catch(() => setTaskCount(null)),
    ]);
    setCapturedAt(new Date().toISOString());
    setBusy(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const cTrunc = clusters.rows.length >= ROW_CAP;
  const sTrunc = services.rows.length >= ROW_CAP;
  // Service-health rollup: only from a LOADED, UNTRUNCATED service page — a 500-row sample
  // sum must not present itself as the fleet total.
  const rollup = services.loaded && !services.err && !sTrunc
    ? services.rows.reduce(
        (a, r) => {
          a.desired += num(d(r, 'desired_count'));
          a.running += num(d(r, 'running_count'));
          return a;
        },
        { desired: 0, running: 0 },
      )
    : null;
  const lagging = rollup ? rollup.desired - rollup.running : null;

  const stale = (t: TypeState) => t.run != null && t.run.status !== 'succeeded';
  const preSync = (t: TypeState) => t.loaded && !t.err && t.rows.length === 0 && t.run == null;
  const caption = (t: TypeState, trunc: boolean) => (
    <>
      {t.err && <span className="text-amber-700">{tt('목록을 불러오지 못했습니다.')}</span>}
      {!t.err && stale(t) && (
        <span className="text-amber-700">
          {tt('마지막 sync가 성공하지 못했습니다 — 마지막 성공 시점 데이터일 수 있습니다.')}
        </span>
      )}
      {!t.err && preSync(t) && <span>{tt('미수집 — sync 후 표시됩니다.')}</span>}
      {trunc && <span> ({tt('표본 기준')})</span>}
    </>
  );

  const th = 'px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-400';
  const td = 'px-3 py-1.5 text-[12px] text-ink-700';

  return (
    <>
      <PageHeader
        title={tt('ECS 개요')}
        subtitle={tt('클러스터·서비스·태스크 통합 현황')}
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {/* KPI band */}
        <section className="flex flex-col gap-3">
          <SectionLabel>{tt('요약')}</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label={tt('클러스터')} value={clusters.loaded && !clusters.err ? clusters.rows.length + (cTrunc ? '+' : '') : '—'} href="/inventory/ecs_cluster" />
            <StatTile label={tt('서비스')} value={services.loaded && !services.err ? services.rows.length + (sTrunc ? '+' : '') : '—'} href="/inventory/ecs_service" />
            <StatTile label={tt('태스크')} value={taskCount ?? '—'} href="/inventory/ecs_task" />
            <StatTile
              label={tt('Desired 대비 미달 태스크')}
              value={lagging == null ? `— ${sTrunc ? `(${tt('표본 기준')})` : ''}`.trim() : lagging}
              variant={lagging != null && lagging > 0 ? 'danger' : 'default'}
              hint={rollup ? `${rollup.running}/${rollup.desired} running` : sTrunc ? tt('표본에서는 집계하지 않음') : undefined}
            />
          </div>
        </section>

        {/* Clusters table */}
        <section className="flex flex-col gap-3">
          <SectionLabel right={<Link href="/inventory/ecs_cluster" className="text-[11.5px] text-brand-700 hover:underline">{tt('전체 보기')} →</Link>}>
            {tt('클러스터')}
          </SectionLabel>
          <Card padded={false}>
            <p className="px-3 pt-2 text-[11px] text-ink-400">{caption(clusters, cTrunc)}</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr className="border-b border-ink-100">
                  <th className={th}>Name</th><th className={th}>Status</th><th className={th}>Running</th>
                  <th className={th}>Pending</th><th className={th}>Services</th><th className={th}>Region</th>
                </tr></thead>
                <tbody>
                  {clusters.rows.map((r) => (
                    <tr key={`${r.account_id}/${r.region}/${r.resource_id}`} className="border-b border-ink-50 last:border-0">
                      <td className={`${td} font-mono`}>{r.resource_id}</td>
                      <td className={td}><StatePill value={String(d(r, 'status') ?? '—')} /></td>
                      <td className={`${td} tabular`}>{String(d(r, 'running_tasks_count') ?? '—')}</td>
                      <td className={`${td} tabular`}>{String(d(r, 'pending_tasks_count') ?? '—')}</td>
                      <td className={`${td} tabular`}>{String(d(r, 'active_services_count') ?? '—')}</td>
                      <td className={td}>{r.region}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>

        {/* Services table */}
        <section className="flex flex-col gap-3">
          <SectionLabel right={<Link href="/inventory/ecs_service" className="text-[11.5px] text-brand-700 hover:underline">{tt('전체 보기')} →</Link>}>
            {tt('서비스')}
          </SectionLabel>
          <Card padded={false}>
            <p className="px-3 pt-2 text-[11px] text-ink-400">{caption(services, sTrunc)}</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr className="border-b border-ink-100">
                  <th className={th}>Service</th><th className={th}>Cluster</th><th className={th}>Status</th>
                  <th className={th}>Desired</th><th className={th}>Running</th><th className={th}>Launch</th><th className={th}>Region</th>
                </tr></thead>
                <tbody>
                  {services.rows.map((r) => {
                    const desired = num(d(r, 'desired_count'));
                    const running = num(d(r, 'running_count'));
                    return (
                      <tr key={`${r.account_id}/${r.region}/${r.resource_id}`} className="border-b border-ink-50 last:border-0">
                        <td className={`${td} font-mono`}>{String(d(r, 'service_name') ?? r.resource_id)}</td>
                        <td className={td}>{clusterLeaf(d(r, 'cluster_arn'))}</td>
                        <td className={td}><StatePill value={String(d(r, 'status') ?? '—')} /></td>
                        <td className={`${td} tabular`}>{String(d(r, 'desired_count') ?? '—')}</td>
                        <td className={`${td} tabular ${running < desired ? 'text-rose-600 font-semibold' : ''}`}>{String(d(r, 'running_count') ?? '—')}</td>
                        <td className={td}>{String(d(r, 'launch_type') ?? '—')}</td>
                        <td className={td}>{r.region}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      </div>
    </>
  );
}
