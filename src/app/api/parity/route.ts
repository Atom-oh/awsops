// ADR-030 Phase 1 dual-write parity check.

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth-utils';
import { getConfig } from '@/lib/app-config';
import { isAuroraEnabled, checkDbHealth } from '@/lib/db';
import { getDriftCounters } from '@/lib/db/drift';
import { countAuroraCalls } from '@/lib/db/agentcore-stats-writer';
import { getStats } from '@/lib/agentcore-stats';
import { listEvents } from '@/lib/event-scaling';
import { countAuroraEvents } from '@/lib/db/event-scaling-writer';
import { countAuroraDiagnoses } from '@/lib/db/alert-diagnosis-writer';
import { countJsonDiagnoses } from '@/lib/alert-knowledge-fs';
import { getConversations } from '@/lib/agentcore-memory';
import { countAuroraMemory } from '@/lib/db/agentcore-memory-writer';
import { countJsonInventoryDays } from '@/lib/inventory-fs';
import { countAuroraInventoryRows } from '@/lib/db/inventory-writer';

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
    note: 'JSON side caps at 50 most-recent calls; exact only when volume < 50.',
  };
}

interface CountParity<S extends string> {
  source: S;
  inSync: boolean;
  jsonCount: number;
  auroraCount: number;
  drift: number;
  note: string;
}

async function eventScalingPlansParity(): Promise<CountParity<'event_scaling_plans'>> {
  const jsonCount = listEvents().length;
  const auroraCount = await countAuroraEvents();
  return {
    source: 'event_scaling_plans',
    inSync: jsonCount === auroraCount, jsonCount, auroraCount,
    drift: Math.abs(auroraCount - jsonCount),
    note: 'Count-based parity for slice 3. Per-event field diff lands later.',
  };
}

async function alertDiagnosisParity(): Promise<CountParity<'alert_diagnosis'>> {
  const jsonCount = countJsonDiagnoses();
  const auroraCount = await countAuroraDiagnoses();
  return {
    source: 'alert_diagnosis',
    inSync: jsonCount === auroraCount, jsonCount, auroraCount,
    drift: Math.abs(auroraCount - jsonCount),
    note: 'INSERT idempotent on (incident_id) so duplicate dispatches do not inflate.',
  };
}

async function agentcoreMemoryParity(): Promise<CountParity<'agentcore_memory'>> {
  const jsonCount = (await getConversations(10_000)).length;
  const auroraCount = await countAuroraMemory();
  return {
    source: 'agentcore_memory',
    inSync: jsonCount === auroraCount, jsonCount, auroraCount,
    drift: Math.abs(auroraCount - jsonCount),
    note: 'JSON keeps last 100; Aurora keeps until expires_at (365d). Exact only when volume < 100.',
  };
}

async function inventorySnapshotsParity(): Promise<CountParity<'inventory_snapshots'>> {
  const jsonCount = countJsonInventoryDays();
  const auroraCount = await countAuroraInventoryRows({ distinct: true });
  return {
    source: 'inventory_snapshots',
    inSync: jsonCount === auroraCount, jsonCount, auroraCount,
    drift: Math.abs(auroraCount - jsonCount),
    note: 'Compares snapshot-days not rows; Aurora stores N rows per snapshot.',
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
  const filteredDrift = source ? driftCounters.filter((c) => c.source === source) : driftCounters;

  if (source === 'agentcore_stats') {
    return NextResponse.json({ auroraEnabled: true, health, drift: filteredDrift, parity: [await agentcoreStatsParity(hours)] });
  }
  if (source === 'event_scaling_plans') {
    return NextResponse.json({ auroraEnabled: true, health, drift: filteredDrift, parity: [await eventScalingPlansParity()] });
  }
  if (source === 'alert_diagnosis') {
    return NextResponse.json({ auroraEnabled: true, health, drift: filteredDrift, parity: [await alertDiagnosisParity()] });
  }
  if (source === 'agentcore_memory') {
    return NextResponse.json({ auroraEnabled: true, health, drift: filteredDrift, parity: [await agentcoreMemoryParity()] });
  }
  if (source === 'inventory_snapshots') {
    return NextResponse.json({ auroraEnabled: true, health, drift: filteredDrift, parity: [await inventorySnapshotsParity()] });
  }

  return NextResponse.json({
    auroraEnabled: true,
    health,
    drift: driftCounters,
    parity: [
      await agentcoreStatsParity(hours),
      await eventScalingPlansParity(),
      await alertDiagnosisParity(),
      await agentcoreMemoryParity(),
      await inventorySnapshotsParity(),
    ],
    note:
      'Phase 1 dual-write — 5 of 7 sources wired (agentcore_stats, event_scaling_plans, ' +
      'alert_diagnosis, agentcore_memory, inventory_snapshots). cost_snapshots and ' +
      'report_schedules land in subsequent commits.',
  });
}
