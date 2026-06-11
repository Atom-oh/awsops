# EKS v1-Parity UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/eks` 리스트를 v1 `/k8s` Overview 구성(클러스터 카드 + 노드 리소스 바 + Pod 차트 + Warning Events)으로 재구축하고, `/eks/[cluster]` 탭마다 리소스별 KPI/시각화를 추가한다. 전부 read-only.

**Architecture:** Wave-1 고립 커밋 `fdc9626`(eks-resources.ts 집계 + Nodes 탭 Meter)을 cherry-pick으로 기반 확보 → `events` kind와 순수 탭 통계 헬퍼를 lib에 추가 → 서버 집계 전용 `/api/eks/fleet` 라우트(클러스터별 fan-out, pod 원본 비전송) → 리스트 페이지를 카드 기반으로 재구성, 상세 탭에 KPI/차트 부착.

**Tech Stack:** Next.js 14 (thin-BFF), vitest (+jsdom page tests), 기존 UI 컴포넌트(StatTile/Card/Meter/Badge/DataTable/DonutBreakdown/BarDistribution), presigned-STS in-cluster GET.

**Spec:** `docs/superpowers/specs/2026-06-11-eks-v1-parity-ui-design.md`

**파일 스코프 (scope guard):**
- Modify: `web/lib/eks-incluster.ts`, `web/lib/eks-incluster.test.ts`, `web/app/eks/page.tsx`, `web/app/eks/eks-list.test.tsx`, `web/app/eks/[cluster]/page.tsx`
- Create: `web/lib/eks-resources.ts`, `web/lib/eks-resources.test.ts` (cherry-pick), `web/lib/eks-tab-stats.ts`, `web/lib/eks-tab-stats.test.ts`, `web/app/api/eks/fleet/route.ts`, `web/app/api/eks/fleet/route.test.ts`

---

### Task 1: Wave-1 노드 리소스 기반 cherry-pick

**Files:**
- Create: `web/lib/eks-resources.ts`, `web/lib/eks-resources.test.ts`
- Modify: `web/lib/eks-incluster.ts`, `web/lib/eks-incluster.test.ts`, `web/app/eks/[cluster]/page.tsx`

- [ ] **Step 1: cherry-pick 실행**

```bash
git cherry-pick -x fdc9626
# 예상: web/lib/eks-incluster.test.ts 1건 충돌 (양쪽 모두 테스트 추가)
```

- [ ] **Step 2: 충돌 해소** — `web/lib/eks-incluster.test.ts`에서 HEAD 측 테스트(예: nodeRoles fallback)와 fdc9626 측 테스트(capacity/allocatable/requests 파싱) **둘 다 보존**하는 방향으로 병합. `<<<<<<<` 마커 제거 후:

```bash
git add web/lib/eks-incluster.test.ts && git cherry-pick --continue
```

- [ ] **Step 3: 검증**

```bash
cd web && npx vitest run && npx tsc --noEmit
```
Expected: 전체 green (fdc9626은 원브랜치에서 392 green이었음). 실패 시 충돌 병합 부위만 수정.

- [ ] **Step 4: 커밋 확인** — cherry-pick이 이미 커밋했으므로 `git log --oneline -1`로 확인만.

---

### Task 2: `events` kind (TDD)

**Files:**
- Modify: `web/lib/eks-incluster.ts`, `web/lib/eks-incluster.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `web/lib/eks-incluster.test.ts`에 추가:

```ts
import { normalizeEvent, isKind } from './eks-incluster';

describe('normalizeEvent', () => {
  it('maps a Warning event to EventRow with sortable timestamp', () => {
    const row = normalizeEvent({
      metadata: { namespace: 'default', creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Pod', name: 'web-abc' },
      reason: 'BackOff', message: 'Back-off restarting failed container',
      count: 7, lastTimestamp: '2026-06-11T01:02:03Z', type: 'Warning',
    });
    expect(row.kind).toBe('Pod');
    expect(row.object).toBe('default/web-abc');
    expect(row.reason).toBe('BackOff');
    expect(row.count).toBe(7);
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T01:02:03Z'));
    expect(row.lastSeen).toBeTruthy(); // compact age string
  });
  it('falls back count→1 and lastTimestamp→eventTime→creationTimestamp', () => {
    const row = normalizeEvent({
      metadata: { creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Node', name: 'n1' },
      reason: 'X', message: 'm', eventTime: '2026-06-11T00:30:00Z',
    });
    expect(row.count).toBe(1);
    expect(row.object).toBe('n1'); // no namespace → name only
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T00:30:00Z'));
  });
  it('events is a valid kind', () => { expect(isKind('events')).toBe(true); });
});
```

- [ ] **Step 2: 실패 확인** — `cd web && npx vitest run lib/eks-incluster.test.ts` → FAIL (normalizeEvent not exported)

- [ ] **Step 3: 구현** — `web/lib/eks-incluster.ts`:

```ts
// Kind 확장
export type Kind = 'nodes' | 'pods' | 'deployments' | 'services' | 'namespaces' | 'events';
const KIND_PATH: Record<Kind, string> = {
  // …기존 5개…
  events: '/api/v1/events?fieldSelector=type=Warning', // Warning만 (v1 parity, read-only GET)
};
export function isKind(k: string): k is Kind { /* 기존 || k === 'events' */ }

// K8sItem에 이벤트 필드 추가 (interface 확장)
//   involvedObject?: { kind?: string; name?: string };
//   reason?: string; message?: string; count?: number;
//   lastTimestamp?: string; eventTime?: string; type?: string;

export interface EventRow {
  kind: string; object: string; reason: string; message: string;
  count: number; lastSeen: string; lastSeenTs: number;
}

export function normalizeEvent(it: K8sItem): EventRow {
  const ns = it.metadata?.namespace;
  const name = it.involvedObject?.name ?? '';
  const ts = it.lastTimestamp ?? it.eventTime ?? it.metadata?.creationTimestamp ?? '';
  const tsMs = ts ? Date.parse(ts) : 0;
  return {
    kind: it.involvedObject?.kind ?? '',
    object: ns ? `${ns}/${name}` : name,
    reason: it.reason ?? '',
    message: it.message ?? '',
    count: it.count ?? 1,
    lastSeen: age(ts),
    lastSeenTs: Number.isFinite(tsMs) ? tsMs : 0,
  };
}
// NORMALIZERS에 events: normalizeEvent 추가, InClusterRow union에 EventRow 추가
```

- [ ] **Step 4: green 확인 + 커밋**

```bash
cd web && npx vitest run lib/eks-incluster.test.ts && npx tsc --noEmit
git add web/lib/eks-incluster.ts web/lib/eks-incluster.test.ts
git commit -m "feat(eks-ui): events kind — Warning events via in-cluster GET (read-only)"
```

---

### Task 3: 순수 탭 통계 헬퍼 (TDD)

**Files:**
- Create: `web/lib/eks-tab-stats.ts`, `web/lib/eks-tab-stats.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `web/lib/eks-tab-stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { podStatusCounts, podsByNamespace, deploymentHealth, serviceTypeCounts } from './eks-tab-stats';

const pods = [
  { namespace: 'a', status: 'Running' }, { namespace: 'a', status: 'Running' },
  { namespace: 'b', status: 'Pending' }, { namespace: 'b', status: 'Failed' },
];
describe('eks-tab-stats', () => {
  it('podStatusCounts counts by status', () => {
    expect(podStatusCounts(pods)).toEqual({ Running: 2, Pending: 1, Failed: 1 });
  });
  it('podsByNamespace sorts desc', () => {
    expect(podsByNamespace(pods)).toEqual([{ namespace: 'a', count: 2 }, { namespace: 'b', count: 2 }]);
  });
  it('deploymentHealth parses ready a/b, degraded first', () => {
    const out = deploymentHealth([
      { name: 'ok', namespace: 'x', ready: '3/3', available: 3 },
      { name: 'bad', namespace: 'x', ready: '1/3', available: 1 },
    ]);
    expect(out[0]).toEqual({ name: 'bad', namespace: 'x', desired: 3, available: 1, pct: 33 });
    expect(out[1].pct).toBe(100);
  });
  it('deploymentHealth treats desired 0 as 100%', () => {
    expect(deploymentHealth([{ name: 'z', namespace: 'x', ready: '0/0', available: 0 }])[0].pct).toBe(100);
  });
  it('serviceTypeCounts counts by type', () => {
    expect(serviceTypeCounts([{ type: 'ClusterIP' }, { type: 'ClusterIP' }, { type: 'LoadBalancer' }]))
      .toEqual({ ClusterIP: 2, LoadBalancer: 1 });
  });
});
```

- [ ] **Step 2: 실패 확인** → 모듈 없음 FAIL

- [ ] **Step 3: 구현** — `web/lib/eks-tab-stats.ts` (client-safe, 서버 import 금지):

```ts
// Pure aggregation helpers for the EKS tab/fleet visualizations.
// CRITICAL: client-safe — no server-only imports (mirrors eks-resources.ts).

export function podStatusCounts(rows: { status?: unknown }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const s = String(r.status ?? '') || 'Unknown'; out[s] = (out[s] ?? 0) + 1; }
  return out;
}

export function podsByNamespace(rows: { namespace?: unknown }[]): { namespace: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const ns = String(r.namespace ?? '') || '—'; m.set(ns, (m.get(ns) ?? 0) + 1); }
  return [...m.entries()].map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));
}

export interface DeploymentHealth { name: string; namespace: string; desired: number; available: number; pct: number }
export function deploymentHealth(rows: { name?: unknown; namespace?: unknown; ready?: unknown; available?: unknown }[]): DeploymentHealth[] {
  return rows.map((r) => {
    const desired = parseInt(String(r.ready ?? '').split('/')[1] ?? '0', 10) || 0;
    const available = Number(r.available ?? 0) || 0;
    const pct = desired > 0 ? Math.max(0, Math.min(100, Math.round((available / desired) * 100))) : 100;
    return { name: String(r.name ?? ''), namespace: String(r.namespace ?? ''), desired, available, pct };
  }).sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));
}

export function serviceTypeCounts(rows: { type?: unknown }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const t = String(r.type ?? '') || 'Unknown'; out[t] = (out[t] ?? 0) + 1; }
  return out;
}
```

- [ ] **Step 4: green + 커밋**

```bash
cd web && npx vitest run lib/eks-tab-stats.test.ts && npx tsc --noEmit
git add web/lib/eks-tab-stats.ts web/lib/eks-tab-stats.test.ts
git commit -m "feat(eks-ui): pure tab-stats helpers (pod status/ns, deployment health, service types)"
```

---

### Task 4: `/api/eks/fleet` 라우트 (TDD)

**Files:**
- Create: `web/app/api/eks/fleet/route.ts`, `web/app/api/eks/fleet/route.test.ts`

- [ ] **Step 1: 실패 테스트** — `web/app/api/eks/fleet/route.test.ts` (기존 `api/eks/route.test.ts` mock 패턴):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getAllowedClusters = vi.fn();
const listInCluster = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/eks-registry', () => ({ getAllowedClusters: (...a: unknown[]) => getAllowedClusters(...a) }));
vi.mock('@/lib/eks-incluster', () => ({ listInCluster: (...a: unknown[]) => listInCluster(...a) }));
import { GET } from './route';

const req = () => new Request('http://x/api/eks/fleet', { headers: { cookie: 'awsops_token=t' } });
const NODE = { name: 'n1', status: 'Ready', roles: 'worker', version: 'v1.30', instanceType: 'm5.large', zone: 'a', age: '1d', cpuCapacity: 4, cpuAllocatable: 3.9, memCapacity: 16000, memAllocatable: 15000 };
const POD = { name: 'p1', namespace: 'default', status: 'Running', node: 'n1', restarts: 0, age: '1h', cpuRequest: 0.5, memRequest: 512 };
const EVENT = { kind: 'Pod', object: 'default/p1', reason: 'BackOff', message: 'm', count: 3, lastSeen: '5m', lastSeenTs: 1000 };

beforeEach(() => {
  verifyUser.mockReset(); getAllowedClusters.mockReset(); listInCluster.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  getAllowedClusters.mockResolvedValue(new Set(['c1']));
});

describe('GET /api/eks/fleet', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
  it('aggregates per cluster server-side (no raw pods in payload)', async () => {
    listInCluster.mockImplementation(async (_c: string, kind: string) => (
      { nodes: [NODE], pods: [POD], deployments: [{ name: 'd', namespace: 'x', ready: '1/1', available: 1 }], services: [{ type: 'ClusterIP' }], events: [EVENT] } as Record<string, unknown[]>
    )[kind] ?? []);
    const body = await (await GET(req())).json();
    const c = body.clusters[0];
    expect(c.name).toBe('c1');
    expect(c.reachable).toBe(true);
    expect(c.counts).toEqual({ nodes: 1, nodesReady: 1, pods: 1, podsRunning: 1, deployments: 1, services: 1 });
    expect(c.nodeAgg[0].name).toBe('n1');
    expect(c.podStatus).toEqual({ Running: 1 });
    expect(c.podsByNamespace).toEqual([{ namespace: 'default', count: 1 }]);
    expect(c.events[0].reason).toBe('BackOff');
    expect(JSON.stringify(body)).not.toContain('"restarts"'); // raw pod rows must not ship
  });
  it('degrades a failing cluster to reachable:false (never 500)', async () => {
    getAllowedClusters.mockResolvedValue(new Set(['ok', 'down']));
    listInCluster.mockImplementation(async (c: string, kind: string) => {
      if (c === 'down') throw new Error('403');
      return ({ nodes: [NODE], pods: [POD], deployments: [], services: [], events: [] } as Record<string, unknown[]>)[kind] ?? [];
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const down = body.clusters.find((c: { name: string }) => c.name === 'down');
    expect(down.reachable).toBe(false);
    expect(down.counts.nodes).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인** → 모듈 없음 FAIL

- [ ] **Step 3: 구현** — `web/app/api/eks/fleet/route.ts`:

```ts
import { verifyUser } from '@/lib/auth';
import { getAllowedClusters } from '@/lib/eks-registry';
import { listInCluster, type NodeRow, type PodRow, type DeploymentRow, type ServiceRow, type EventRow } from '@/lib/eks-incluster';
import { aggregateNodeResources } from '@/lib/eks-resources';
import { podStatusCounts, podsByNamespace, serviceTypeCounts } from '@/lib/eks-tab-stats';

export const dynamic = 'force-dynamic';

// v1 /k8s Overview parity: per-cluster live aggregates, computed SERVER-side.
// Raw pod rows never ship to the client (thin-BFF) — only small aggregates do.
// Per-cluster failures degrade to reachable:false (the fleet view must not 500).

const EVENTS_CAP = 25;
const NS_CAP = 10;

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const names = [...(await getAllowedClusters())];
  const clusters = await Promise.all(names.map(async (name) => {
    try {
      const [nodes, pods, deployments, services, events] = await Promise.all([
        listInCluster(name, 'nodes') as Promise<NodeRow[]>,
        listInCluster(name, 'pods') as Promise<PodRow[]>,
        listInCluster(name, 'deployments') as Promise<DeploymentRow[]>,
        listInCluster(name, 'services') as Promise<ServiceRow[]>,
        listInCluster(name, 'events').catch(() => []) as Promise<EventRow[]>, // events-only failure must not kill the cluster entry
      ]);
      return {
        name,
        reachable: true,
        counts: {
          nodes: nodes.length,
          nodesReady: nodes.filter((n) => n.status === 'Ready').length,
          pods: pods.length,
          podsRunning: pods.filter((p) => p.status === 'Running').length,
          deployments: deployments.length,
          services: services.length,
        },
        nodeAgg: aggregateNodeResources(nodes, pods),
        podStatus: podStatusCounts(pods),
        podsByNamespace: podsByNamespace(pods).slice(0, NS_CAP),
        serviceTypes: serviceTypeCounts(services),
        events: [...events].sort((a, b) => b.lastSeenTs - a.lastSeenTs).slice(0, EVENTS_CAP),
      };
    } catch {
      return {
        name, reachable: false,
        counts: { nodes: 0, nodesReady: 0, pods: 0, podsRunning: 0, deployments: 0, services: 0 },
        nodeAgg: [], podStatus: {}, podsByNamespace: [], serviceTypes: {}, events: [],
      };
    }
  }));
  return Response.json({ clusters });
}
```

- [ ] **Step 4: green + 커밋**

```bash
cd web && npx vitest run app/api/eks/fleet/route.test.ts && npx tsc --noEmit
git add web/app/api/eks/fleet/
git commit -m "feat(eks-ui): /api/eks/fleet — per-cluster server-side aggregates (counts/nodeAgg/podStatus/events)"
```

---

### Task 5: `/eks` 리스트 페이지 재구성 (카드 + 노드 바 + 차트 + 이벤트)

**Files:**
- Modify: `web/app/eks/page.tsx`, `web/app/eks/eks-list.test.tsx`

- [ ] **Step 1: 테스트 갱신 (먼저)** — `web/app/eks/eks-list.test.tsx`: `SUMMARY` mock을 `FLEET`으로 교체, 기존 4개 동작(connected 링크·register 플로우·스크립트 가이드·stats 행) 유지 + 카드/노드/이벤트 어서션 추가:

```ts
const FLEET = {
  'GET /api/eks/fleet': () => ({
    status: 200,
    body: { clusters: [{
      name: 'conn', reachable: true,
      counts: { nodes: 2, nodesReady: 2, pods: 10, podsRunning: 9, deployments: 3, services: 4 },
      nodeAgg: [{ name: 'n1', cpuAllocatable: 3.9, cpuRequest: 1.2, cpuPct: 31, memAllocatable: 15000, memRequest: 4000, memPct: 27, podCount: 5 }],
      podStatus: { Running: 9, Pending: 1 },
      podsByNamespace: [{ namespace: 'default', count: 6 }, { namespace: 'kube-system', count: 4 }],
      serviceTypes: { ClusterIP: 4 },
      events: [{ kind: 'Pod', object: 'default/p1', reason: 'BackOff', message: 'restarting', count: 3, lastSeen: '5m', lastSeenTs: 1000 }],
    }] },
  }),
};
// 모든 mockFetch({ ...SUMMARY, ... }) → mockFetch({ ...FLEET, ... })
// 'renders the fleet summary stats row' 테스트: '10'(pods) 어서션 유지
// 추가 어서션:
//   - 클러스터 카드: screen.getByText('vpc-1') (카드 본문 VPC), getByText(/2 nodes/) (미니 카운트)
//   - 노드 리소스: getByText('n1')
//   - Warning Events: getByText('BackOff')
```

실행: `npx vitest run app/eks/eks-list.test.tsx` → FAIL (페이지가 아직 summary/테이블)

- [ ] **Step 2: 페이지 재구성** — `web/app/eks/page.tsx` 전체 교체. 기존 `register`/`unregister`/`guide` 패널(Copied! 포함)·`btn` 스타일·notice 로직은 **그대로 이관**하고 렌더만 카드화:

```tsx
'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import DataTable from '@/components/ui/DataTable';
import Badge from '@/components/ui/Badge';
import StatCard from '@/components/ui/StatCard';
import Card from '@/components/ui/Card';
import Meter from '@/components/ui/Meter';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import BarDistribution from '@/components/charts/BarDistribution';

// v1 /k8s Overview parity: cluster cards + per-node resource bars + pod charts
// + Warning events — paper+ink. Register/guide UX unchanged (auto-register aware).

interface Cluster { /* 기존 그대로 */ }
interface Guide { commands: string[]; note: string }
interface FleetCluster {
  name: string; reachable: boolean;
  counts: { nodes: number; nodesReady: number; pods: number; podsRunning: number; deployments: number; services: number };
  nodeAgg: { name: string; cpuAllocatable: number; cpuRequest: number; cpuPct: number; memAllocatable: number; memRequest: number; memPct: number; podCount: number }[];
  podStatus: Record<string, number>;
  podsByNamespace: { namespace: string; count: number }[];
  events: { kind: string; object: string; reason: string; message: string; count: number; lastSeen: string; lastSeenTs: number }[];
}

export default function EksPage() {
  // 기존 state 유지 (summary → fleet 교체)
  const [fleet, setFleet] = useState<FleetCluster[] | null>(null);
  // load(): /api/eks (기존) · useEffect: /api/eks/fleet → setFleet

  const fleetBy = useMemo(() => new Map((fleet ?? []).map((f) => [f.name, f])), [fleet]);
  const totals = useMemo(() => { /* fleet 합산: connected/nodes/nodesReady/pods/podsRunning/deployments/services */ }, [fleet]);
  const podStatusData = useMemo(() => { /* fleet podStatus 병합 → [{name, value}] */ }, [fleet]);
  const nsData = useMemo(() => { /* fleet podsByNamespace 병합 → top 10 [{namespace, count}] */ }, [fleet]);
  const eventRows = useMemo(() => { /* fleet events 병합 + cluster 필드, lastSeenTs desc */ }, [fleet]);

  return (
    <div className="px-8 py-8 flex flex-col gap-6">
      {/* 1. 헤더 (기존) */}
      {/* 2. Stats 행: Clusters / Connected / Nodes(trend `${nodesReady} ready`) / Pods(trend `${podsRunning} running`) / Deployments / Services */}
      {/* 3. notice/err/guide 패널 (기존 그대로) */}
      {/* 4. 클러스터 카드 그리드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {(rows ?? []).map((c) => {
          const f = fleetBy.get(c.name);
          return (
            <Card key={c.name} className="p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                {c.access === 'connected'
                  ? <Link href={`/eks/${encodeURIComponent(c.name)}`} className="font-mono text-[13px] font-semibold text-claude-600 hover:underline truncate">{c.name}</Link>
                  : <span className="font-mono text-[13px] font-semibold text-ink-700 truncate">{c.name}</span>}
                <span className="flex items-center gap-1.5 shrink-0">
                  {/* access Badge 4종 — 기존 로직 그대로 */}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <div><span className="text-ink-400">Version</span> <span className="text-ink-700">{c.version}</span></div>
                <div><span className="text-ink-400">Region</span> <span className="text-ink-700">{c.region}</span></div>
                <div><span className="text-ink-400">VPC</span> <span className="text-ink-700">{c.vpcId || '—'}</span></div>
                <div><span className="text-ink-400">Platform</span> <span className="text-ink-700">{c.platformVersion || '—'}</span></div>
              </div>
              {f?.reachable && (
                <div className="text-[12px] text-ink-500">{f.counts.nodes} nodes · {f.counts.pods} pods · {f.counts.deployments} deploys</div>
              )}
              {c.access === 'connected' && f && !f.reachable && <Badge tone="negative" variant="soft">조회 불가</Badge>}
              <div className="flex items-center gap-2">{/* [조회 등록]/[스크립트]/[해제] 버튼 — 기존 로직 그대로 */}</div>
            </Card>
          );
        })}
      </div>
      {/* 5. 노드 리소스 — fleet에서 reachable && nodeAgg.length>0 인 클러스터별 그룹 */}
      {/*    Card title="노드 리소스" → 클러스터별 font-mono 소제목 + fdc9626 상세페이지와 동일한 행 레이아웃(name+podCount, CPU Meter, Mem Meter) */}
      {/* 6. 차트 행 */}
      {/*    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DonutBreakdown title="Pod Status" data={podStatusData} nameKey="name" valueKey="value" />
              <BarDistribution title="Pods per Namespace" data={nsData} xKey="namespace" yKey="count" />
            </div>  — fleet 합산이 0이면 섹션 생략 */}
      {/* 7. Warning Events — eventRows.length>0 일 때만:
            <Card title="Warning Events" subtitle="최근 클러스터 경고 (Warning type only)">
              <DataTable columns={[cluster,kind,object,reason,message,count,lastSeen]} rows={eventRows} />
            </Card>
            0건 + fleet 있음 → 조용한 "경고 이벤트 없음" 한 줄 */}
    </div>
  );
}
```

주의: DataTable 제거 — 카드가 대체. 기존 `tableRows` 삭제. `lastSeenTs`는 렌더 컬럼에서 제외(정렬용 사전 sort만).

- [ ] **Step 3: green 확인**

```bash
cd web && npx vitest run app/eks/eks-list.test.tsx && npx vitest run && npx tsc --noEmit
```

- [ ] **Step 4: 커밋**

```bash
git add web/app/eks/page.tsx web/app/eks/eks-list.test.tsx
git commit -m "feat(eks-ui): /eks rebuilt as v1-parity overview — cluster cards, node resource bars, pod charts, warning events"
```

---

### Task 6: `/eks/[cluster]` 탭별 차별화

**Files:**
- Modify: `web/app/eks/[cluster]/page.tsx`

- [ ] **Step 1: Events 탭 추가** — `Tab` union + `TABS`에 `{ value: 'events', label: 'Events' }` (Diagnosis 앞), `COLUMNS.events`:

```ts
events: [
  { key: 'kind', label: 'Kind' },
  { key: 'object', label: 'Object' },
  { key: 'reason', label: 'Reason' },
  { key: 'message', label: 'Message' },
  { key: 'count', label: 'Count' },
  { key: 'lastSeen', label: 'Last Seen' },
],
```
load()는 기존 incluster fetch가 kind=events를 그대로 처리. rows를 `lastSeenTs` desc로 사전 정렬 후 set. `lastSeenTs`는 컬럼 비노출.

- [ ] **Step 2: 탭별 KPI/차트 블록** — import 추가(`StatTile`(=StatCard), `DonutBreakdown`, `Meter`, eks-tab-stats 헬퍼) 후, 검색/필터 행 위에 탭 조건부 렌더 (전부 `allRows` 기준 — 필터 전):

```tsx
{tab === 'pods' && allRows.length > 0 && (() => {
  const s = podStatusCounts(allRows as { status?: unknown }[]);
  const donut = Object.entries(s).map(([name, value]) => ({ name, value }));
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total" value={allRows.length} />
        <StatCard label="Running" value={s.Running ?? 0} />
        <StatCard label="Pending" value={s.Pending ?? 0} variant={s.Pending ? 'warn' : 'default'} />
        <StatCard label="Failed" value={s.Failed ?? 0} variant={s.Failed ? 'danger' : 'default'} />
      </div>
      <DonutBreakdown title="Pod Status" data={donut} nameKey="name" valueKey="value" />
    </>
  );
})()}

{tab === 'deployments' && allRows.length > 0 && (() => {
  const h = deploymentHealth(allRows as Parameters<typeof deploymentHealth>[0]);
  const degraded = h.filter((d) => d.pct < 100).length;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Total" value={h.length} />
        <StatCard label="Fully available" value={h.length - degraded} />
        <StatCard label="Degraded" value={degraded} variant={degraded ? 'danger' : 'default'} />
      </div>
      <Card title="레플리카 가용성" subtitle="available / desired (degraded 우선)">
        <div className="flex flex-col gap-2">
          {h.map((d) => (
            <div key={`${d.namespace}/${d.name}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 text-[12px]">
              <span className="min-w-0 truncate font-mono text-ink-700" title={`${d.namespace}/${d.name}`}>{d.namespace}/{d.name}</span>
              <Meter value={d.pct} />
              <span className="tabular text-ink-400">{d.available}/{d.desired}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
})()}

{tab === 'services' && allRows.length > 0 && (() => {
  const t = serviceTypeCounts(allRows as { type?: unknown }[]);
  const donut = Object.entries(t).map(([name, value]) => ({ name, value }));
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total" value={allRows.length} />
        <StatCard label="ClusterIP" value={t.ClusterIP ?? 0} />
        <StatCard label="NodePort" value={t.NodePort ?? 0} />
        <StatCard label="LoadBalancer" value={t.LoadBalancer ?? 0} />
      </div>
      <DonutBreakdown title="Service Types" data={donut} nameKey="name" valueKey="value" />
    </>
  );
})()}
```
Nodes 탭은 Task 1(cherry-pick)의 "노드 리소스" Card 그대로. Diagnosis 변경 없음. events는 `NAMESPACED` 미포함(네임스페이스 필터 없음 — object에 ns 포함됨).

- [ ] **Step 3: 검증 + 커밋**

```bash
cd web && npx vitest run && npx tsc --noEmit
git add "web/app/eks/[cluster]/page.tsx"
git commit -m "feat(eks-ui): per-tab KPI/viz — pods status donut, deployment replica bars, service types, events tab"
```

---

### Task 7: 최종 검증 + 배포

- [ ] **Step 1: 전체 게이트**

```bash
cd web && npx vitest run && npx tsc --noEmit && npx next lint --quiet 2>/dev/null || true
```
Expected: 전체 green (393+ 신규).

- [ ] **Step 2: 배포 + smoke** (컨트롤러 실행)

```bash
git branch --show-current   # = feat/v2-architecture-design 확인
make deploy                  # arm64 build → ECR → ECS rolling → /api/health smoke
```

- [ ] **Step 3: 라이브 확인** — `https://awsops-v2.atomai.click/eks` 카드/노드 바/차트/이벤트, `/eks/mall-apne2-az-a` 탭별 KPI.
