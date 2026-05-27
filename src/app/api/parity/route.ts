// ADR-030 Phase 1 dual-write parity check.
//
// During Phase 1, JSON is the source of truth and Aurora is a shadow write.
// This endpoint compares the two so the 7-day parity gate (zero drift) from
// the ADR can be measured before Phase 2 flips reads to Aurora.
//
// GET /api/parity                        → all sources, current drift snapshot
// GET /api/parity?source=agentcore_stats&hours=24
//                                        → 24h window comparison for one source
//
// Admin-only.

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth-utils';
import { getConfig } from '@/lib/app-config';
import { isAuroraEnabled, checkDbHealth } from '@/lib/db';
import { getDriftCounters } from '@/lib/db/drift';
import { countAuroraCalls } from '@/lib/db/agentcore-stats-writer';
import { getStats } from '@/lib/agentcore-stats';
import { readSchedule } from '@/lib/report-scheduler';
import { readScheduleFromAurora, type AuroraScheduleRow } from '@/lib/db/schedule-writer';

function isAdminUser(req: NextRequest): boolean {
  const user = getUserFromRequest(req);
  const config = getConfig();
  if (!config.adminEmails || config.adminEmails.length === 0) return true;
  return config.adminEmails.includes(user.email);
}

interface AgentCoreStatsParity {
  source: 'agentcore_stats';
  windowHours: number;
  jsonRecentCalls: number;
  auroraCount: number;
  drift: number;
  note: string;
}

interface ReportSchedulesParity {
  source: 'report_schedules';
  inSync: boolean;
  mismatchedFields: string[];
  jsonRow: {
    frequency: string;
    enabled: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
  auroraRow: AuroraScheduleRow | null;
}

async function agentcoreStatsParity(hours: number): Promise<AgentCoreStatsParity> {
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3_600_000);

  const jsonStats = getStats();
  const jsonRecentInWindow = jsonStats.recentCalls.filter((c) => {
    const t = new Date(c.timestamp).getTime();
    return t >= since.getTime() && t < until.getTime();
  }).length;

  const auroraCount = await countAuroraCalls(since, until);

  return {
    source: 'agentcore_stats',
    windowHours: hours,
    jsonRecentCalls: jsonRecentInWindow,
    auroraCount,
    drift: Math.abs(auroraCount - jsonRecentInWindow),
    note:
      'JSON side caps at 50 most-recent calls; comparison is exact only ' +
      'when call volume in the window < 50. Use the drift counter for ' +
      'cumulative write-failure visibility.',
  };
}

async function reportSchedulesParity(): Promise<ReportSchedulesParity> {
  const json = readSchedule();
  const aurora = await readScheduleFromAurora();

  const jsonRow = {
    frequency: json.frequency,
    enabled: json.enabled,
    lastRunAt: json.lastRunAt,
    nextRunAt: json.nextRunAt,
  };

  if (!aurora) {
    return {
      source: 'report_schedules',
      inSync: false,
      mismatchedFields: ['_no_aurora_row'],
      jsonRow,
      auroraRow: null,
    };
  }

  const mismatchedFields: string[] = [];
  if (json.frequency !== aurora.scheduleType) mismatchedFields.push('frequency');
  if (json.enabled !== aurora.enabled) mismatchedFields.push('enabled');
  if ((json.lastRunAt ?? null) !== (aurora.lastRunAt ?? null)) mismatchedFields.push('lastRunAt');
  if ((json.nextRunAt ?? null) !== (aurora.nextRunAt ?? null)) mismatchedFields.push('nextRunAt');

  return {
    source: 'report_schedules',
    inSync: mismatchedFields.length === 0,
    mismatchedFields,
    jsonRow,
    auroraRow: aurora,
  };
}

export async function GET(req: NextRequest) {
  if (!isAdminUser(req)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  if (!isAuroraEnabled()) {
    return NextResponse.json({
      auroraEnabled: false,
      message:
        'Aurora not configured. Set AURORA_DATABASE_URL or AURORA_HOST/USER/PASSWORD/DB. ' +
        'See ADR-030 and scripts/13-deploy-aurora.sh.',
    });
  }

  const { searchParams } = new URL(req.url);
  const source = searchParams.get('source');
  const hours = Math.max(1, Math.min(168, Number(searchParams.get('hours') ?? '24')));

  let health: { ok: true; schemaVersion: number } | { ok: false; error: string };
  try {
    health = await checkDbHealth();
  } catch (err) {
    health = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const driftCounters = getDriftCounters();

  if (source === 'agentcore_stats') {
    return NextResponse.json({
      auroraEnabled: true,
      health,
      drift: driftCounters.filter((c) => c.source === source),
      parity: [await agentcoreStatsParity(hours)],
    });
  }
  if (source === 'report_schedules') {
    return NextResponse.json({
      auroraEnabled: true,
      health,
      drift: driftCounters.filter((c) => c.source === source),
      parity: [await reportSchedulesParity()],
    });
  }

  return NextResponse.json({
    auroraEnabled: true,
    health,
    drift: driftCounters,
    parity: [await agentcoreStatsParity(hours), await reportSchedulesParity()],
    note:
      'Phase 1 dual-write — agentcore_stats + report_schedules wired so far. ' +
      'Other sources (inventory, cost, memory, alerts, event-scaling) land in subsequent commits.',
  });
}
