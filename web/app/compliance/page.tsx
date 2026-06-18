'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import StatTile, { type StatTileVariant } from '@/components/ui/StatTile';
import Meter from '@/components/ui/Meter';
import DataTable from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import DonutBreakdown from '@/components/charts/DonutBreakdown';

interface Benchmark { id: string; name: string; description: string }
interface Run {
  id: number; benchmark: string; status: string; pass_rate: number | null;
  total_controls: number | null; ok: number | null; alarm: number | null;
  info: number | null; skip: number | null; error: number | null;
  started_at?: string; finished_at?: string; error_message?: string | null;
}
interface Result {
  control_id: string; title: string; section: string; status: string;
  reason: string; resource: string; region: string; severity: string;
}

const RESULT_COLS = [
  { key: 'control_id', label: 'Control' },
  { key: 'section', label: 'Section' },
  { key: 'status', label: 'Status' },
  { key: 'resource', label: 'Resource' },
  { key: 'region', label: 'Region' },
];

function passVariant(rate: number): StatTileVariant {
  if (rate >= 80) return 'accent';
  if (rate >= 50) return 'warn';
  return 'danger';
}

export default function CompliancePage() {
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [benchmark, setBenchmark] = useState('cis_v300');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- WIP: setter used (run_id capture); reader pending
  const [runId, setRunId] = useState<number | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Result | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/compliance/benchmarks');
        const b = (await r.json()) as { benchmarks?: Benchmark[] };
        if (b.benchmarks?.length) {
          setBenchmarks(b.benchmarks);
          if (!b.benchmarks.some((x) => x.id === 'cis_v300')) setBenchmark(b.benchmarks[0].id);
        }
      } catch {
        /* selector falls back to the default id */
      }
    })();
  }, []);

  const poll = useCallback(async (id: number) => {
    try {
      const r = await fetch(`/api/compliance/runs/${id}`);
      const body = (await r.json()) as { run?: Run; results?: Result[] };
      if (body.run) {
        setRun(body.run);
        setResults(body.results ?? []);
        if (body.run.status === 'running') {
          pollRef.current = setTimeout(() => void poll(id), 5000);
        } else {
          setBusy(false);
        }
      }
    } catch {
      setBusy(false);
    }
  }, []);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const runBenchmark = useCallback(async () => {
    setErr('');
    setBusy(true);
    setRun(null);
    setResults([]);
    try {
      const r = await fetch('/api/compliance/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ benchmark }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setErr(e.message || `Failed to start (${r.status})`);
        setBusy(false);
        return;
      }
      const { run_id } = (await r.json()) as { run_id: number };
      setRunId(run_id);
      void poll(run_id);
    } catch {
      setErr('벤치마크 실행을 시작하지 못했습니다.');
      setBusy(false);
    }
  }, [benchmark, poll]);

  // Per-section pass% (client-side rollup over the leaf results).
  const sections = useMemo(() => {
    const m = new Map<string, { ok: number; total: number }>();
    for (const r of results) {
      const s = m.get(r.section) ?? { ok: 0, total: 0 };
      s.total += 1;
      if (r.status === 'ok') s.ok += 1;
      m.set(r.section, s);
    }
    return [...m.entries()]
      .map(([section, v]) => ({ section, pct: v.total ? (v.ok / v.total) * 100 : 0, ...v }))
      .sort((a, b) => a.pct - b.pct);
  }, [results]);

  const statusDist = run
    ? [
        { name: 'OK', value: run.ok ?? 0 },
        { name: 'Alarm', value: run.alarm ?? 0 },
        { name: 'Info', value: run.info ?? 0 },
        { name: 'Skip', value: run.skip ?? 0 },
        { name: 'Error', value: run.error ?? 0 },
      ]
    : [];

  const passRate = run?.pass_rate != null ? Number(run.pass_rate) : null;

  return (
    <div>
      <PageHeader
        title="Compliance"
        subtitle="CIS AWS Foundations Benchmark — Powerpipe (read-only) against the live account"
        right={
          <div className="flex items-center gap-2">
            <select
              value={benchmark}
              onChange={(e) => setBenchmark(e.target.value)}
              disabled={busy}
              className="rounded-md border border-ink-100 bg-card px-2.5 py-1.5 text-[13px] text-ink-800"
            >
              {(benchmarks.length ? benchmarks : [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }]).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <Button variant="primary" size="sm" onClick={runBenchmark} disabled={busy}>
              {busy ? '실행 중…' : 'Run Benchmark'}
            </Button>
          </div>
        }
      />
      <div className="px-8 py-6">
        {err && <Card className="mb-4 text-[14px] text-brand-700">{err}</Card>}

        {!run && !busy && (
          <Card className="text-[14px] text-ink-500">
            Select a benchmark and run it. Results (pass rate, per-section breakdown, and per-control
            findings) appear here and are saved as run history. Requires the Steampipe inventory
            (steampipe_enabled) to be active.
          </Card>
        )}

        {busy && !run && <Card className="text-[14px] text-ink-500">벤치마크 실행 중… (수 분 소요될 수 있습니다)</Card>}

        {run && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
              <StatTile
                label="Pass Rate"
                value={passRate != null ? `${passRate.toFixed(1)}%` : '—'}
                variant={passRate != null ? passVariant(passRate) : 'default'}
              />
              <StatTile label="Total" value={run.total_controls ?? 0} />
              <StatTile label="Passed" value={run.ok ?? 0} variant="accent" />
              <StatTile label="Alarm" value={run.alarm ?? 0} variant="danger" />
              <StatTile label="Skipped" value={run.skip ?? 0} />
              <StatTile label="Error" value={run.error ?? 0} variant={run.error ? 'warn' : 'default'} />
            </div>

            {run.status === 'failed' && (
              <Card className="mt-4 text-[14px] text-brand-700">
                Benchmark failed: {run.error_message || 'unknown error'}
              </Card>
            )}

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <DonutBreakdown title="Controls by status" data={statusDist} nameKey="name" valueKey="value" />
              <Card>
                <div className="mb-3 text-[13px] font-semibold text-ink-700">Pass rate by section</div>
                <div className="flex flex-col gap-2">
                  {sections.length === 0 && <div className="text-[13px] text-ink-400">데이터 없음</div>}
                  {sections.map((s) => (
                    <div key={s.section} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-[13px] text-ink-700" title={s.section}>{s.section}</span>
                      <Meter value={s.pct} />
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <div className="mt-6">
              <div className="mb-3 text-[13px] font-semibold text-ink-700">Controls</div>
              <DataTable
                columns={RESULT_COLS}
                rows={results as unknown as Record<string, unknown>[]}
                onRowClick={(row) => setSelected(row as unknown as Result)}
                cardTitleKey="control_id"
              />
            </div>
          </>
        )}
      </div>

      <DetailPanel
        title={selected ? `${selected.control_id} — ${selected.title}` : undefined}
        data={selected as unknown as Record<string, unknown> | null}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
