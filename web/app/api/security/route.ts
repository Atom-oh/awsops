import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { FINDING_SQL, rowToFinding, CHECK_META, type CheckKey, type Finding } from '@/lib/security-findings';
import { ecrCveFindings } from '@/lib/ecr-cve';

export const dynamic = 'force-dynamic';

const CHECKS = Object.keys(CHECK_META) as CheckKey[];

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const pool = getPool();
    // Presence probe: any rows for the security-relevant resource types? If none, the inventory
    // sync hasn't run (or steampipe_enabled is OFF) → report disabled so the page shows a notice.
    // NOTE (accepted, MINOR): this conflates "not yet synced" with "steampipe OFF", and a partial
    // sync (only some types present) reads as enabled with empty checks — acceptable for v1-parity.
    const probe = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM inventory_resources
       WHERE account_id='self'
         AND resource_type IN ('s3_public_access','security_group','ebs_volume','iam_user')`,
    );
    if (Number(probe.rows[0]?.n ?? 0) === 0) {
      return Response.json({ enabled: false, summary: {}, findings: {} });
    }
    const summary = {} as Record<CheckKey, number>;
    const findings = {} as Record<CheckKey, Finding[]>;
    for (const check of CHECKS) {
      if (!(check in FINDING_SQL)) continue; // live-SDK checks handled below
      const r = await pool.query<{ resource_id: string; region: string; detail: unknown }>(FINDING_SQL[check as keyof typeof FINDING_SQL]);
      findings[check] = r.rows.map((row) => rowToFinding(check, row));
      summary[check] = findings[check].length;
    }
    // Container CVEs: live ECR scan summaries — degrades to an empty tab, never fails the page.
    try {
      findings.ecr_cve = await ecrCveFindings();
    } catch {
      findings.ecr_cve = [];
    }
    summary.ecr_cve = findings.ecr_cve.length;
    return Response.json({ enabled: true, summary, findings });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
