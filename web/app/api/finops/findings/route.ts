// ADR-019 FinOps baseline-recommendations engine — read-only surface for /cost. Thin-BFF: reads
// finops_findings + the latest finops_runs row (the daily worker owns all the writes; the request
// path never calls a live AWS API). Gated on FINOPS_BASELINE_ENABLED (omitted from the web task def
// when the feature flag is off — see workload.tf), matching the /api/insights pattern.
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return Response.json(obj, { status });
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return json({ status: 'error', message: 'unauthenticated' }, 401);
  }
  if (process.env.FINOPS_BASELINE_ENABLED !== 'true') {
    return json({ enabled: false, findings: [], lastRun: null }, 200);
  }
  try {
    const [findingsRes, runRes] = await Promise.all([
      getPool().query(
        `SELECT id, rule_id, account_id, region, resource_id, title, category, status, monthly_savings_usd,
                evidence, guard_hits, explanation_ko, first_seen_at, last_seen_at
           FROM finops_findings
          WHERE status != 'resolved'
          ORDER BY (monthly_savings_usd IS NULL), monthly_savings_usd DESC NULLS LAST, first_seen_at DESC`,
      ),
      getPool().query(
        `SELECT id, started_at, finished_at, status, rules_evaluated, findings_count, ce_api_calls, error
           FROM finops_runs
          ORDER BY started_at DESC
          LIMIT 1`,
      ),
    ]);
    const findings = findingsRes.rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      accountId: r.account_id,
      region: r.region,
      resourceId: r.resource_id,
      title: r.title,
      category: r.category,
      status: r.status,
      monthlySavingsUsd: r.monthly_savings_usd === null ? null : Number(r.monthly_savings_usd),
      evidence: r.evidence,
      guardHits: r.guard_hits ?? [],
      explanationKo: r.explanation_ko,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    }));
    const lastRun = runRes.rows[0]
      ? {
          id: runRes.rows[0].id,
          startedAt: runRes.rows[0].started_at,
          finishedAt: runRes.rows[0].finished_at,
          status: runRes.rows[0].status,
          rulesEvaluated: runRes.rows[0].rules_evaluated,
          findingsCount: runRes.rows[0].findings_count,
          ceApiCalls: runRes.rows[0].ce_api_calls,
          error: runRes.rows[0].error,
        }
      : null;
    return json({ enabled: true, findings, lastRun }, 200);
  } catch (e) {
    return json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, 500);
  }
}
