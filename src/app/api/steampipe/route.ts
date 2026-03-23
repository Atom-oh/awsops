import { NextRequest, NextResponse } from 'next/server';
import { batchQuery, clearCache, checkCostAvailability } from '@/lib/steampipe';
import { saveSnapshot, getHistory } from '@/lib/resource-inventory';
import { saveCostSnapshot, getLatestCostSnapshot } from '@/lib/cost-snapshot';
import { getConfig, saveConfig } from '@/lib/app-config';
import { getCacheWarmerStatus, ensureCacheWarmerStarted } from '@/lib/cache-warmer';

export async function GET(request: NextRequest) {
  // Auto-start cache warmer on first request / 첫 요청 시 캐시 워머 자동 시작
  ensureCacheWarmerStarted();

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');
  const bustCache = searchParams.get('bustCache') === 'true';

  if (action === 'cost-check') {
    try {
      const result = await checkCostAvailability(bustCache);
      return NextResponse.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Cost check failed';
      return NextResponse.json({ available: false, reason: message }, { status: 500 });
    }
  }

  if (action === 'inventory') {
    try {
      const days = parseInt(searchParams.get('days') || '90');
      const history = await getHistory(days);
      return NextResponse.json({ history });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Inventory fetch failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (action === 'config') {
    return NextResponse.json(getConfig());
  }

  if (action === 'cache-status') {
    return NextResponse.json(getCacheWarmerStatus());
  }

  if (action === 'cost-snapshot') {
    try {
      const snapshot = await getLatestCostSnapshot();
      if (!snapshot) {
        return NextResponse.json({ error: 'No cost snapshot available' }, { status: 404 });
      }
      return NextResponse.json(snapshot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Cost snapshot fetch failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return NextResponse.json(
    { error: 'Unknown action. Valid: cost-check, inventory, cost-snapshot, config' },
    { status: 400 }
  );
}

export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    if (action === 'config') {
      const body = await request.json();
      if (typeof body.costEnabled === 'boolean') {
        saveConfig({ costEnabled: body.costEnabled });
        clearCache(); // cost-check 캐시 무효화
      }
      return NextResponse.json(getConfig());
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // Auto-start cache warmer on first request / 첫 요청 시 캐시 워머 자동 시작
  ensureCacheWarmerStarted();

  try {
    const { searchParams } = new URL(request.url);
    const bustCache = searchParams.get('bustCache') === 'true';

    const body = await request.json();
    const { queries, saveInventory } = body as {
      queries: Record<string, string>;
      saveInventory?: boolean;
    };

    if (!queries || typeof queries !== 'object') {
      return NextResponse.json(
        { error: 'Request body must contain a "queries" object' },
        { status: 400 }
      );
    }

    if (bustCache) {
      clearCache();
    }

    const results = await batchQuery(queries, bustCache);

    // 대시보드 요청 시 리소스 인벤토리 스냅샷 백그라운드 저장
    if (saveInventory) {
      saveSnapshot(results).catch(() => {});
    }

    // 비용 쿼리 성공 시 스냅샷 백그라운드 저장 (dashboard costSummary or cost page monthlyCost)
    if (results['monthlyCost']?.rows?.length || results['costSummary']?.rows?.length) {
      saveCostSnapshot(results).catch(() => {});
    }

    return NextResponse.json(results);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
