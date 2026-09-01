'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import ReportMarkdown from '@/components/diagnosis/ReportMarkdown';
import { useI18n } from '@/components/shell/LanguageProvider';

// Printable report view (gap L179, v1 parity): /ai-diagnosis/report?id=N opens in a new tab
// with a white A4 layout — cover block, numbered anchor TOC, per-section page breaks, and
// Print/Close buttons hidden in print media. The server-generated PDF download remains the
// primary export; this is the browser preview/print path. Access control is the existing
// GET /api/diagnosis/[id] (owner-or-admin) — this page adds no new data surface.

interface ReportMeta {
  id: number; title: string | null; tier: string | null; status: string | null;
  created_at: string | null; finished_at: string | null;
}

// Split on top-level `## ` headings (the worker's section contract). The preamble before the
// first heading (title/intro) stays section 0 without a TOC entry.
function splitSections(md: string): { heading: string | null; body: string }[] {
  const lines = md.split('\n');
  const out: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) out.push({ heading: m[1].trim(), body: [line] });
    else out[out.length - 1].body.push(line);
  }
  return out
    .map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }))
    .filter((s) => s.body.length > 0);
}

function PrintReportInner() {
  const { tt } = useI18n();
  const params = useSearchParams();
  const id = Number(params.get('id'));
  const [state, setState] = useState<{ report: ReportMeta | null; markdown: string | null; err: boolean }>({ report: null, markdown: null, err: false });

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) { setState((s) => ({ ...s, err: true })); return; }
    let alive = true;
    fetch(`/api/diagnosis/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setState({ report: d.report ?? null, markdown: typeof d.markdown === 'string' ? d.markdown : null, err: false }); })
      .catch(() => { if (alive) setState({ report: null, markdown: null, err: true }); });
    return () => { alive = false; };
  }, [id]);

  const sections = useMemo(() => (state.markdown ? splitSections(state.markdown) : []), [state.markdown]);
  const tocEntries = sections.filter((s) => s.heading != null);

  const close = () => {
    // window.close only works for script-opened tabs; fall back to history.
    window.close();
    setTimeout(() => { if (!window.closed) window.history.back(); }, 150);
  };

  if (state.err) {
    return (
      <div className="mx-auto max-w-[210mm] bg-white p-10 text-[13px] text-rose-600">
        {tt('리포트를 불러오지 못했습니다.')}
      </div>
    );
  }
  if (!state.report) {
    return <div className="mx-auto max-w-[210mm] bg-white p-10 text-[13px] text-ink-400">{tt('로딩 중…')}</div>;
  }

  const r = state.report;
  const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—');

  return (
    <div className="min-h-screen bg-white">
      {/* print CSS: white ground, per-section breaks, controls hidden */}
      <style>{`
        @media print {
          .print-hidden { display: none !important; }
          .print-break { break-before: page; }
          body { background: #fff !important; }
        }
      `}</style>
      <div className="mx-auto max-w-[210mm] px-10 py-8">
        <div className="print-hidden mb-6 flex items-center justify-end gap-2">
          <button onClick={() => window.print()} className="rounded-md bg-brand-500 px-3 py-1.5 text-[13px] font-medium text-white">{tt('인쇄')}</button>
          <button onClick={close} className="rounded-md border border-ink-200 px-3 py-1.5 text-[13px] text-ink-600">{tt('닫기')}</button>
        </div>

        {/* Cover block */}
        <header className="mb-8 border-b-2 border-ink-800 pb-6">
          <h1 className="text-[24px] font-bold text-ink-900">{r.title || `AI Diagnosis Report #${r.id}`}</h1>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] text-ink-600">
            <div><dt className="inline text-ink-400">Tier </dt><dd className="inline font-medium">{r.tier ?? '—'}</dd></div>
            <div><dt className="inline text-ink-400">Status </dt><dd className="inline font-medium">{r.status ?? '—'}</dd></div>
            <div><dt className="inline text-ink-400">Created </dt><dd className="inline">{fmt(r.created_at)}</dd></div>
            <div><dt className="inline text-ink-400">Finished </dt><dd className="inline">{fmt(r.finished_at)}</dd></div>
          </dl>
        </header>

        {/* Numbered anchor TOC */}
        {tocEntries.length > 0 && (
          <nav className="mb-8">
            <h2 className="mb-2 text-[15px] font-semibold text-ink-800">{tt('목차')}</h2>
            <ol className="list-decimal space-y-1 pl-6 text-[13px]">
              {tocEntries.map((s, i) => (
                <li key={i}><a href={`#report-sec-${i}`} className="text-brand-700 hover:underline">{s.heading}</a></li>
              ))}
            </ol>
          </nav>
        )}

        {state.markdown === null ? (
          <p className="text-[13px] text-ink-400">{tt('데이터 불가')}</p>
        ) : (
          sections.map((s, idx) => {
            const tocIdx = s.heading != null ? tocEntries.indexOf(s) : -1;
            return (
              <section key={idx} id={tocIdx >= 0 ? `report-sec-${tocIdx}` : undefined} className={idx > 0 ? 'print-break mt-8' : undefined}>
                <ReportMarkdown markdown={s.body} />
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function PrintReportPage() {
  return (
    <Suspense fallback={null}>
      <PrintReportInner />
    </Suspense>
  );
}
