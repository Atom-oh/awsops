'use client';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';

// ADR-019 FinOps baseline-recommendations engine — self-fetching card (mirrors InsightCard's
// enabled/loaded/empty-state shape). Read-only: no action button here, ever — the ADR's own
// invariant is that this domain adds zero AWS-mutation paths (a card showing an IaC-change EXAMPLE
// as text would be allowed by the ADR, but this version doesn't even do that).
interface Finding {
  id: number; ruleId: string; resourceId: string; title: string; category: string;
  status: 'active' | 'needs_review' | 'resolved';
  monthlySavingsUsd: number | null;
  evidence: Record<string, unknown>;
  guardHits: string[];
  explanationKo: string | null;
  firstSeenAt: string; lastSeenAt: string;
}
interface LastRun {
  id: number; startedAt: string; finishedAt: string | null; status: string;
  rulesEvaluated: number | null; findingsCount: number | null; ceApiCalls: number; error: string | null;
}
interface Findings { enabled: boolean; findings: Finding[]; lastRun: LastRun | null }

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  needs_review: 'bg-amber-100 text-amber-700 border-amber-200',
};

function ago(ts: string | null, tt: (s: string) => string): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return tt('방금 전');
  if (s < 3600) return tt(`${Math.round(s / 60)}분 전`);
  if (s < 86400) return tt(`${Math.round(s / 3600)}시간 전`);
  return tt(`${Math.round(s / 86400)}일 전`);
}

export default function FinopsBaselineCard() {
  const { tt } = useI18n();
  const [data, setData] = useState<Findings | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/finops/findings');
      if (r.ok) setData(await r.json());
    } catch { /* best-effort */ } finally { setLoaded(true); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loaded && data?.enabled === false) return null; // feature off -> render nothing (no-op)
  const findings = data?.findings ?? [];
  // The headline total is a CONFIDENT number — only 'active' findings count toward it.
  // 'needs_review' items (stale inventory data, a protected tag, insufficient Compute Optimizer
  // observation window) carry a guard hit specifically because their amount/applicability isn't
  // trustworthy yet; summing them into "월간 절감 가능" would inflate a number the guard system
  // itself just flagged as not-yet-actionable. They're still shown in the list below, just not
  // rolled into this total.
  const confident = findings.filter((f) => f.status === 'active');
  // `reduce` with `?? 0` silently coalesces "every confident item happens to have unknown
  // savings" into a total of exactly 0 — indistinguishable from "confirmed zero savings" once
  // rendered as $0.00. Sum only the known amounts, and track unknown separately, so the render
  // below can say "산출 불가" instead of fabricating a $0.00 headline (the same null-not-zero
  // invariant the per-finding amounts already honor, now also at the aggregate level).
  const knownConfident = confident.filter((f) => f.monthlySavingsUsd !== null);
  const total = knownConfident.reduce((s, f) => s + (f.monthlySavingsUsd as number), 0);
  const unknownCount = confident.length - knownConfident.length;

  return (
    <section className="rounded-xl border border-ink-200 bg-card p-4" data-testid="finops-baseline-card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-ink-800">{tt('FinOps 기본 권장')}</h2>
          {data?.lastRun?.finishedAt && (
            <span className="text-[12px] text-ink-400">
              {tt('배치 기준')} {ago(data.lastRun.finishedAt, tt)}
            </span>
          )}
        </div>
        {confident.length > 0 && (
          <span className="text-[13px] font-medium text-ink-700" data-testid="finops-baseline-total">
            {knownConfident.length > 0 ? (
              <>
                {tt('월간 절감 가능')} {usd(total)}
                {unknownCount > 0 && (
                  <span className="text-ink-400"> {tt(`(+${unknownCount}건 금액 산출 불가)`)}</span>
                )}
              </>
            ) : (
              // Every confident finding has an unknown amount — no known total to show at all.
              // Saying "산출 불가" (not $0.00) keeps the null-not-zero invariant at this level too.
              <>{tt('월간 절감 가능')}: {tt('금액 산출 불가')}</>
            )}
          </span>
        )}
      </div>
      {!loaded ? (
        <p className="text-[13px] text-ink-400">{tt('로딩 중…')}</p>
      ) : data?.lastRun?.status === 'failed' ? (
        <p className="text-[13px] text-rose-600" data-testid="finops-baseline-error">
          {tt('최근 배치 실행이 실패했습니다')}{data.lastRun.error ? `: ${data.lastRun.error}` : ''}
        </p>
      ) : findings.length === 0 ? (
        <p className="text-[13px] text-ink-400" data-testid="finops-baseline-empty">
          {data?.lastRun
            ? tt('현재 발견된 상시 낭비 항목이 없습니다.')
            : tt('아직 배치가 실행되지 않았습니다 — 다음 일일 배치를 기다려주세요.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {findings.map((f) => (
            <li key={f.id} className="flex items-start gap-2" data-testid="finops-baseline-item">
              <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${STATUS_BADGE[f.status] || STATUS_BADGE.active}`}>
                {tt(f.status === 'needs_review' ? '확인 필요' : '활성')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-medium text-ink-800">{f.title}</p>
                  <p className="text-[13px] font-medium text-ink-700 shrink-0">
                    {f.monthlySavingsUsd === null ? tt('금액 산출 불가') : `${usd(f.monthlySavingsUsd)}/mo`}
                  </p>
                </div>
                {f.explanationKo && <p className="text-[12px] text-ink-500">{f.explanationKo}</p>}
                {f.guardHits.length > 0 && (
                  <p className="text-[11px] text-amber-600">{tt('주의')}: {f.guardHits.join(', ')}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
