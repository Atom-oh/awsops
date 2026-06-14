'use client';
import { useEffect, useState, useCallback } from 'react';
import ReportMarkdown from './ReportMarkdown';
import IntentPanel from './IntentPanel';

interface ReportRow {
  id: number;
  tier: string;
  status: string;
  created_at: string;
}

// Plan-2: intended-vs-actual verdict surfaced in summary.drift; regression diff in summary.diff.
interface DriftVerdict {
  id?: number | string;
  kind?: string;
  target?: string | null;
  severity?: string;
  observed?: string;
}
interface ReportSummary {
  drift?: DriftVerdict[];
  diff?: { regressions?: DriftVerdict[]; improvements?: (number | string)[] };
  [k: string]: unknown;
}

const SEV_CLASS: Record<string, string> = {
  critical: 'border-red-200 bg-red-50 text-red-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  info: 'border-ink-200 bg-ink-100 text-ink-600',
};

export default function DiagnosisView() {
  const [tier, setTier] = useState<'light' | 'mid'>('mid');
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [active, setActive] = useState<{ id: number; markdown: string | null; summary: ReportSummary | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); // [PR#37 review] surface deduped reports

  const loadList = useCallback(async () => {
    const r = await fetch('/api/diagnosis');
    if (r.ok) setReports((await r.json()).reports);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const open = async (id: number) => {
    const r = await fetch(`/api/diagnosis/${id}`);
    if (r.ok) {
      const j = await r.json();
      setActive({ id, markdown: j.markdown, summary: (j.report?.summary as ReportSummary) ?? null });
    }
  };

  const run = async () => {
    setRunning(true);
    setNotice(null);
    try {
      const r = await fetch('/api/diagnosis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      if (!r.ok) return;
      const posted = await r.json();
      // [PR#37 review MAJOR] a same-hour re-run is deduped server-side → open the existing report
      // and tell the user (it can be up to ~60min old) instead of silently showing a stale view.
      if (posted?.deduped && posted?.report_id) {
        setNotice('최근 1시간 내 동일 조건 리포트를 표시합니다 (중복 실행 방지 — 최대 60분 이전 결과일 수 있음).');
        await loadList();
        await open(posted.report_id);
        return;
      }
      // Poll the list until a fresh report finishes (simple MVP poll, 3s × 100).
      for (let i = 0; i < 100; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        await loadList();
        const top = (await (await fetch('/api/diagnosis')).json()).reports[0];
        if (top && ['succeeded', 'partial', 'failed'].includes(top.status)) {
          await open(top.id);
          break;
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const download = () => {
    if (!active?.markdown) return;
    const blob = new Blob([active.markdown], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `awsops-diagnosis-${active.id}.md`;
    a.click();
  };

  return (
    <div className="flex gap-6">
      <aside className="w-64 shrink-0 space-y-3">
        <div className="flex items-center gap-2">
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as 'light' | 'mid')}
            className="rounded-md border border-ink-200 px-2 py-1 text-sm"
          >
            <option value="light">Light</option>
            <option value="mid">Mid</option>
          </select>
          <button
            onClick={run}
            disabled={running}
            className="rounded-md bg-claude-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {running ? '진단 중…' : '진단 실행'}
          </button>
        </div>
        <ul className="space-y-1">
          {reports.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => open(r.id)}
                className="w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-ink-100"
              >
                #{r.id} · {r.tier} · <span className="text-ink-400">{r.status}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="min-w-0 flex-1">
        {notice && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            {notice}
          </div>
        )}
        <div className="mb-4">
          <IntentPanel />
        </div>
        {active?.markdown ? (
          <>
            <div className="mb-3 flex justify-end">
              <button
                onClick={download}
                className="rounded-md border border-ink-200 px-3 py-1.5 text-sm"
              >
                Markdown 다운로드
              </button>
            </div>
            {active.summary && <ReportInsights summary={active.summary} />}
            <ReportMarkdown markdown={active.markdown} />
          </>
        ) : (
          <p className="text-sm text-ink-400">리포트를 선택하거나 “진단 실행”을 누르세요.</p>
        )}
      </main>
    </div>
  );
}

// Plan-2: intended-vs-actual drift + regression-vs-previous diff, surfaced as small badge sections.
function ReportInsights({ summary }: { summary: ReportSummary }) {
  const drift = summary.drift ?? [];
  const regressions = summary.diff?.regressions ?? [];
  const improvements = summary.diff?.improvements ?? [];
  if (drift.length === 0 && regressions.length === 0 && improvements.length === 0) return null;
  return (
    <div className="mb-4 space-y-3">
      {drift.length > 0 && (
        <div className="rounded-md border border-ink-200 bg-paper p-3">
          <div className="mb-2 text-[12px] font-semibold text-ink-700">의도 대비 실제 (intended vs actual) — 위반 {drift.length}건</div>
          <div className="flex flex-wrap gap-1.5">
            {drift.map((v, idx) => (
              <span
                key={`${v.id}-${idx}`}
                title={v.observed}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${SEV_CLASS[v.severity ?? 'info'] ?? SEV_CLASS.info}`}
              >
                {v.kind}{v.target ? ` → ${v.target}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      {(regressions.length > 0 || improvements.length > 0) && (
        <div className="rounded-md border border-ink-200 bg-paper p-3">
          <div className="mb-2 text-[12px] font-semibold text-ink-700">이전 리포트 대비 변화 (diff)</div>
          <div className="flex flex-wrap gap-1.5">
            {regressions.map((v, idx) => (
              <span key={`reg-${idx}`} title={v.observed} className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700">
                ▲ 악화: {v.kind ?? 'posture'}{v.target ? ` → ${v.target}` : ''}
              </span>
            ))}
            {improvements.map((id, idx) => (
              <span key={`imp-${idx}`} className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
                ▼ 해소: #{String(id)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
