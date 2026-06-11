'use client';
import { useEffect, useState, useCallback } from 'react';
import ReportMarkdown from './ReportMarkdown';

interface ReportRow {
  id: number;
  tier: string;
  status: string;
  created_at: string;
}

export default function DiagnosisView() {
  const [tier, setTier] = useState<'light' | 'mid'>('mid');
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [active, setActive] = useState<{ id: number; markdown: string | null } | null>(null);
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
      setActive({ id, markdown: j.markdown });
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
            <ReportMarkdown markdown={active.markdown} />
          </>
        ) : (
          <p className="text-sm text-ink-400">리포트를 선택하거나 “진단 실행”을 누르세요.</p>
        )}
      </main>
    </div>
  );
}
