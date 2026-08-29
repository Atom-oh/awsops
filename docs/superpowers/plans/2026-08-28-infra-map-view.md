# Infra Map View + K8s Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two columnar graph views (5-column Infra Map, 4-column K8s Map) as view toggles on `/topology/infra`, rendered on ReactFlow with cross-highlighting and a legend — closing gap-audit items L163/L164/L248.

**Architecture:** Pure graph-builder modules (`web/lib/infra-map.ts`, `web/lib/k8s-map.ts`) turn already-available API rows into a `MapGraph { nodes, edges }`; a shared `MapCanvas` React component renders any `MapGraph` on ReactFlow with fixed column x-positions, custom card nodes, selection closure highlighting, and a legend. No new backend routes or tables — the only server-side change is one new read-only in-cluster kind (`ingresses`).

**Tech Stack:** Next.js 14 App Router (client components), `@xyflow/react` (already a dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-infra-map-view-design.md`

## Global Constraints

- Work in worktree `.claude/worktrees/infra-map-view`, branch `feat/infra-map-view` (base `origin/main`). All commands below run from `<worktree>/web/` unless noted.
- All components `export default`; fetch paths are `/api/*` (no basePath).
- `web/lib/*` map modules must be React-free (no React imports) — they are unit-tested with vitest.
- ReactFlow must be imported client-only (`dynamic(() => import('@xyflow/react')…, { ssr: false })`) — it touches the DOM on mount.
- In-cluster reads stay read-only GET; secrets remain rejected (pinned allow-list invariant).
- Korean-first UI strings, consistent with the existing `/topology/infra` page.
- Commit after every green test cycle (small units — concurrent sessions switch branches).
- Typecheck gate: `npx tsc --noEmit -p .` (no npm script wraps it).

---

### Task 1: `web/lib/infra-map.ts` — types + `buildInfraMap()`

**Files:**
- Create: `web/lib/infra-map.ts`
- Test: `web/lib/infra-map.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (used by Tasks 2, 4, 5, 6):
  - `type MapKind = 'igw' | 'tgw' | 'vpc' | 'subnet' | 'ec2' | 'alb' | 'nlb' | 'rds' | 'nat' | 'ingress' | 'service' | 'pod' | 'node'`
  - `interface MapNode { id: string; kind: MapKind; column: number; label: string; sub?: string; badge?: string; status?: 'ok' | 'warn' | 'bad' | 'neutral'; meta: Record<string, unknown> }`
  - `interface MapEdge { source: string; target: string }`
  - `interface MapGraph { nodes: MapNode[]; edges: MapEdge[] }`
  - `interface InvRow { resource_id: string; region: string | null; data: Record<string, unknown> }`
  - `interface TgwAttachmentLite { tgwId: string; resourceType: string; resourceId: string }`
  - `interface InfraMapInput { igw: InvRow[]; tgw: InvRow[]; vpc: InvRow[]; subnet: InvRow[]; ec2: InvRow[]; alb: InvRow[]; nlb: InvRow[]; rds: InvRow[]; nat: InvRow[]; tgwAttachments?: TgwAttachmentLite[] }`
  - `function buildInfraMap(input: InfraMapInput): MapGraph`

Column indexes: 0 = External (igw+tgw), 1 = VPC, 2 = Subnet, 3 = Compute (ec2+alb+nlb+rds), 4 = NAT.
Node ids are `${kind}:${resource_id}`. Data fields come from the synced inventory `data` JSON
(see `scripts/v2/steampipe/sync_lambda.py` QUERIES): igw `attachments[].VpcId`; subnet
`vpc_id`/`availability_zone`/`cidr_block`/`map_public_ip_on_launch`; ec2
`subnet_id`/`vpc_id`/`instance_state`/`instance_type`/`private_ip_address`/`public_ip_address`;
alb/nlb `vpc_id`/`availability_zones[].SubnetId`/`state_code`/`scheme`; rds `vpc_id`/`engine`/
`status`/`class`; nat `vpc_id`/`subnet_id`/`state`.

- [ ] **Step 1: Write the failing test**

`web/lib/infra-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildInfraMap, type InfraMapInput, type InvRow } from './infra-map';

const row = (resource_id: string, data: Record<string, unknown> = {}): InvRow =>
  ({ resource_id, region: 'ap-northeast-2', data });

const empty = (): InfraMapInput =>
  ({ igw: [], tgw: [], vpc: [], subnet: [], ec2: [], alb: [], nlb: [], rds: [], nat: [] });

const fixture = (): InfraMapInput => ({
  ...empty(),
  igw: [row('igw-1', { attachments: [{ VpcId: 'vpc-a', State: 'available' }] })],
  tgw: [row('tgw-1', { state: 'available', description: 'core' })],
  vpc: [
    row('vpc-a', { name: 'prod', cidr_block: '10.0.0.0/16' }),
    row('vpc-b', { name: 'dev', cidr_block: '10.1.0.0/16' }),
  ],
  subnet: [
    row('subnet-a1', { vpc_id: 'vpc-a', availability_zone: 'apne2-a', cidr_block: '10.0.1.0/24', map_public_ip_on_launch: true, name: 'pub-a' }),
    row('subnet-a2', { vpc_id: 'vpc-a', availability_zone: 'apne2-c', cidr_block: '10.0.2.0/24', map_public_ip_on_launch: false }),
  ],
  ec2: [row('i-1', { name: 'web', subnet_id: 'subnet-a2', vpc_id: 'vpc-a', instance_state: 'running', instance_type: 't4g.large', private_ip_address: '10.0.2.10' })],
  alb: [row('alb-x', { name: 'edge', vpc_id: 'vpc-a', state_code: 'active', scheme: 'internal', availability_zones: [{ SubnetId: 'subnet-a1' }, { SubnetId: 'subnet-a2' }] })],
  rds: [row('db-1', { engine: 'aurora-postgresql', status: 'available', class: 'db.serverless', vpc_id: 'vpc-a' })],
  nat: [row('nat-1', { vpc_id: 'vpc-a', subnet_id: 'subnet-a1', state: 'available' })],
  tgwAttachments: [{ tgwId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-b' }],
});

describe('buildInfraMap', () => {
  it('assigns kinds to their columns', () => {
    const g = buildInfraMap(fixture());
    const col = (id: string) => g.nodes.find((n) => n.id === id)?.column;
    expect(col('igw:igw-1')).toBe(0);
    expect(col('tgw:tgw-1')).toBe(0);
    expect(col('vpc:vpc-a')).toBe(1);
    expect(col('subnet:subnet-a1')).toBe(2);
    expect(col('ec2:i-1')).toBe(3);
    expect(col('alb:alb-x')).toBe(3);
    expect(col('rds:db-1')).toBe(3);
    expect(col('nat:nat-1')).toBe(4);
  });

  it('draws containment/attachment edges', () => {
    const g = buildInfraMap(fixture());
    const has = (s: string, t: string) => g.edges.some((e) => e.source === s && e.target === t);
    expect(has('igw:igw-1', 'vpc:vpc-a')).toBe(true);
    expect(has('tgw:tgw-1', 'vpc:vpc-b')).toBe(true);
    expect(has('vpc:vpc-a', 'subnet:subnet-a1')).toBe(true);
    expect(has('subnet:subnet-a2', 'ec2:i-1')).toBe(true);
    expect(has('vpc:vpc-a', 'rds:db-1')).toBe(true);   // RDS attaches at VPC (no subnet id synced)
    expect(has('subnet:subnet-a1', 'nat:nat-1')).toBe(true);
  });

  it('fans a multi-subnet ALB out to one edge per subnet', () => {
    const g = buildInfraMap(fixture());
    const albEdges = g.edges.filter((e) => e.target === 'alb:alb-x');
    expect(albEdges.map((e) => e.source).sort()).toEqual(['subnet:subnet-a1', 'subnet:subnet-a2']);
  });

  it('drops edges to unknown ids but keeps the node', () => {
    const input = { ...empty(), ec2: [row('i-orphan', { subnet_id: 'subnet-missing', instance_state: 'stopped' })] };
    const g = buildInfraMap(input);
    expect(g.nodes.some((n) => n.id === 'ec2:i-orphan')).toBe(true);
    expect(g.edges).toEqual([]);
  });

  it('marks status and public-subnet badge', () => {
    const g = buildInfraMap(fixture());
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node('ec2:i-1').status).toBe('ok');          // running
    expect(node('nat:nat-1').status).toBe('ok');        // available
    expect(node('subnet:subnet-a1').badge).toContain('public');
    expect(node('subnet:subnet-a2').badge ?? '').not.toContain('public');
  });

  it('sorts subnets by (vpc, az, name) and stacks deterministically', () => {
    const g = buildInfraMap(fixture());
    const subnets = g.nodes.filter((n) => n.kind === 'subnet').map((n) => n.id);
    expect(subnets).toEqual(['subnet:subnet-a1', 'subnet:subnet-a2']);
  });

  it('uses name as label with id fallback', () => {
    const g = buildInfraMap(fixture());
    expect(g.nodes.find((n) => n.id === 'vpc:vpc-a')?.label).toBe('prod');
    expect(g.nodes.find((n) => n.id === 'subnet:subnet-a2')?.label).toBe('subnet-a2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/infra-map.test.ts`
Expected: FAIL — cannot resolve `./infra-map`.

- [ ] **Step 3: Write the implementation**

`web/lib/infra-map.ts`:

```ts
// Pure MapGraph builder for the /topology/infra columnar map views (gap-audit L163).
// React-free: unit-tested with vitest; the ReactFlow rendering lives in
// components/topology/MapCanvas.tsx.

export type MapKind =
  | 'igw' | 'tgw' | 'vpc' | 'subnet' | 'ec2' | 'alb' | 'nlb' | 'rds' | 'nat'
  | 'ingress' | 'service' | 'pod' | 'node';

export interface MapNode {
  id: string;            // `${kind}:${resourceId}` — unique across kinds
  kind: MapKind;
  column: number;
  label: string;
  sub?: string;
  badge?: string;
  status?: 'ok' | 'warn' | 'bad' | 'neutral';
  meta: Record<string, unknown>; // searchable extras (ids, IPs, types)
}
export interface MapEdge { source: string; target: string }
export interface MapGraph { nodes: MapNode[]; edges: MapEdge[] }

export interface InvRow { resource_id: string; region: string | null; data: Record<string, unknown> }
export interface TgwAttachmentLite { tgwId: string; resourceType: string; resourceId: string }

export interface InfraMapInput {
  igw: InvRow[]; tgw: InvRow[]; vpc: InvRow[]; subnet: InvRow[];
  ec2: InvRow[]; alb: InvRow[]; nlb: InvRow[]; rds: InvRow[]; nat: InvRow[];
  /** VPC attachments from GET /api/tgw?ids=… (live) — optional; absent → TGW nodes render edge-less. */
  tgwAttachments?: TgwAttachmentLite[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const EC2_STATUS: Record<string, MapNode['status']> = {
  running: 'ok', stopped: 'warn', terminated: 'bad', 'shutting-down': 'bad',
  pending: 'neutral', stopping: 'warn',
};

/** Loadbalancer rows carry subnet membership as availability_zones[].SubnetId. */
function lbSubnets(data: Record<string, unknown>): string[] {
  const azs = Array.isArray(data.availability_zones) ? data.availability_zones : [];
  return azs.map((a) => str((a as Record<string, unknown>).SubnetId ?? (a as Record<string, unknown>).subnet_id)).filter(Boolean);
}

export function buildInfraMap(input: InfraMapInput): MapGraph {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const vpcIds = new Set(input.vpc.map((r) => r.resource_id));
  const subnetIds = new Set(input.subnet.map((r) => r.resource_id));
  const subnetVpc = new Map(input.subnet.map((r) => [r.resource_id, str(r.data.vpc_id)]));
  const label = (r: InvRow) => str(r.data.name) || r.resource_id;
  const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

  // ── column 0: External (IGW · TGW) ─────────────────────────────────────
  for (const r of [...input.igw].sort(byKey(label))) {
    nodes.push({ id: `igw:${r.resource_id}`, kind: 'igw', column: 0, label: label(r), sub: r.resource_id, status: 'neutral', meta: r.data });
    const atts = Array.isArray(r.data.attachments) ? (r.data.attachments as Record<string, unknown>[]) : [];
    for (const a of atts) {
      const v = str(a.VpcId ?? a.vpc_id);
      if (vpcIds.has(v)) edges.push({ source: `igw:${r.resource_id}`, target: `vpc:${v}` });
    }
  }
  for (const r of [...input.tgw].sort(byKey(label))) {
    nodes.push({
      id: `tgw:${r.resource_id}`, kind: 'tgw', column: 0, label: label(r),
      sub: str(r.data.description) || r.resource_id,
      status: str(r.data.state) === 'available' ? 'ok' : 'warn', meta: r.data,
    });
  }
  for (const a of input.tgwAttachments ?? []) {
    if (a.resourceType === 'vpc' && vpcIds.has(a.resourceId)) {
      edges.push({ source: `tgw:${a.tgwId}`, target: `vpc:${a.resourceId}` });
    }
  }

  // ── column 1: VPC ──────────────────────────────────────────────────────
  for (const r of [...input.vpc].sort(byKey(label))) {
    nodes.push({
      id: `vpc:${r.resource_id}`, kind: 'vpc', column: 1, label: label(r),
      sub: `${str(r.data.cidr_block)} · ${r.resource_id}`,
      badge: r.data.is_default === true ? 'default' : undefined, status: 'neutral', meta: r.data,
    });
  }

  // ── column 2: Subnet (sorted by vpc, az, name) ─────────────────────────
  const subnetSort = (r: InvRow) => `${str(r.data.vpc_id)}|${str(r.data.availability_zone)}|${label(r)}`;
  for (const r of [...input.subnet].sort(byKey(subnetSort))) {
    const pub = r.data.map_public_ip_on_launch === true;
    nodes.push({
      id: `subnet:${r.resource_id}`, kind: 'subnet', column: 2, label: label(r),
      sub: str(r.data.cidr_block),
      badge: [str(r.data.availability_zone), pub ? 'public' : ''].filter(Boolean).join(' · '),
      status: 'neutral', meta: r.data,
    });
    const v = str(r.data.vpc_id);
    if (vpcIds.has(v)) edges.push({ source: `vpc:${v}`, target: `subnet:${r.resource_id}` });
  }

  // ── column 3: Compute (EC2 · ALB · NLB · RDS; sorted by vpc, subnet, kind, name) ──
  type ComputeEntry = { r: InvRow; kind: MapKind; subnets: string[]; vpc: string };
  const compute: ComputeEntry[] = [
    ...input.ec2.map((r) => ({ r, kind: 'ec2' as MapKind, subnets: [str(r.data.subnet_id)].filter(Boolean), vpc: str(r.data.vpc_id) })),
    ...input.alb.map((r) => ({ r, kind: 'alb' as MapKind, subnets: lbSubnets(r.data), vpc: str(r.data.vpc_id) })),
    ...input.nlb.map((r) => ({ r, kind: 'nlb' as MapKind, subnets: lbSubnets(r.data), vpc: str(r.data.vpc_id) })),
    ...input.rds.map((r) => ({ r, kind: 'rds' as MapKind, subnets: [], vpc: str(r.data.vpc_id) })),
  ].sort(byKey((c) => `${c.vpc || subnetVpc.get(c.subnets[0] ?? '') || ''}|${c.subnets[0] ?? ''}|${c.kind}|${label(c.r)}`));
  for (const c of compute) {
    const id = `${c.kind}:${c.r.resource_id}`;
    const d = c.r.data;
    const node: MapNode = { id, kind: c.kind, column: 3, label: label(c.r), status: 'neutral', meta: d };
    if (c.kind === 'ec2') {
      node.sub = str(d.instance_type);
      node.badge = str(d.private_ip_address);
      node.status = EC2_STATUS[str(d.instance_state)] ?? 'neutral';
    } else if (c.kind === 'alb' || c.kind === 'nlb') {
      node.sub = `${c.kind.toUpperCase()} · ${str(d.scheme)}`;
      node.status = str(d.state_code) === 'active' ? 'ok' : 'warn';
    } else {
      node.sub = `${str(d.engine)} · ${str(d.class)}`;
      node.status = str(d.status) === 'available' ? 'ok' : 'warn';
    }
    nodes.push(node);
    let linked = false;
    for (const s of c.subnets) {
      if (subnetIds.has(s)) { edges.push({ source: `subnet:${s}`, target: id }); linked = true; }
    }
    if (!linked && vpcIds.has(c.vpc)) edges.push({ source: `vpc:${c.vpc}`, target: id });
  }

  // ── column 4: NAT (sorted by vpc, subnet) ──────────────────────────────
  const natSort = (r: InvRow) => `${str(r.data.vpc_id)}|${str(r.data.subnet_id)}|${r.resource_id}`;
  for (const r of [...input.nat].sort(byKey(natSort))) {
    const id = `nat:${r.resource_id}`;
    nodes.push({
      id, kind: 'nat', column: 4, label: label(r), sub: r.resource_id,
      status: str(r.data.state) === 'available' ? 'ok' : 'warn', meta: r.data,
    });
    const s = str(r.data.subnet_id);
    if (subnetIds.has(s)) edges.push({ source: `subnet:${s}`, target: id });
    else if (vpcIds.has(str(r.data.vpc_id))) edges.push({ source: `vpc:${str(r.data.vpc_id)}`, target: id });
  }

  return { nodes, edges };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/infra-map.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/infra-map.ts web/lib/infra-map.test.ts
git commit -m "feat(topology): pure MapGraph builder for the 5-column infra map"
```

---

### Task 2: `infra-map.ts` — `highlightClosure()` + `searchMatches()`

**Files:**
- Modify: `web/lib/infra-map.ts` (append)
- Test: `web/lib/infra-map.test.ts` (append)

**Interfaces:**
- Consumes: `MapGraph` (Task 1).
- Produces (used by Tasks 5, 6, 7):
  - `function highlightClosure(graph: MapGraph, selectedId: string): Set<string>` — selected node + transitive ancestors + transitive descendants (NOT siblings).
  - `function searchMatches(graph: MapGraph, query: string): Set<string>` — case-insensitive substring over id/label/sub/badge and all string/number values in `meta` (arrays/objects recursed). Empty/whitespace query → empty set.

- [ ] **Step 1: Write the failing tests** (append to `web/lib/infra-map.test.ts`)

```ts
import { highlightClosure, searchMatches } from './infra-map';

describe('highlightClosure', () => {
  it('EC2 selection lights ancestors up to VPC (and its IGW) but not sibling subnets', () => {
    const g = buildInfraMap(fixture());
    const hl = highlightClosure(g, 'ec2:i-1');
    expect(hl.has('ec2:i-1')).toBe(true);
    expect(hl.has('subnet:subnet-a2')).toBe(true);
    expect(hl.has('vpc:vpc-a')).toBe(true);
    expect(hl.has('igw:igw-1')).toBe(true);       // ancestor of vpc-a
    expect(hl.has('subnet:subnet-a1')).toBe(false); // sibling — must stay dim
    expect(hl.has('rds:db-1')).toBe(false);         // sibling
  });

  it('VPC selection lights all descendants and its external ancestors', () => {
    const g = buildInfraMap(fixture());
    const hl = highlightClosure(g, 'vpc:vpc-a');
    for (const id of ['subnet:subnet-a1', 'subnet:subnet-a2', 'ec2:i-1', 'alb:alb-x', 'rds:db-1', 'nat:nat-1', 'igw:igw-1']) {
      expect(hl.has(id)).toBe(true);
    }
    expect(hl.has('vpc:vpc-b')).toBe(false);
    expect(hl.has('tgw:tgw-1')).toBe(false); // attached to vpc-b only
  });
});

describe('searchMatches', () => {
  it('matches instance type and private IP through meta', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, 't4g.large').has('ec2:i-1')).toBe(true);
    expect(searchMatches(g, '10.0.2.10').has('ec2:i-1')).toBe(true);
  });
  it('matches CIDR and is case-insensitive on labels', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, '10.0.1.0/24').has('subnet:subnet-a1')).toBe(true);
    expect(searchMatches(g, 'PROD').has('vpc:vpc-a')).toBe(true);
  });
  it('returns empty set for blank query', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, '   ').size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run lib/infra-map.test.ts`
Expected: FAIL — `highlightClosure` not exported.

- [ ] **Step 3: Implement** (append to `web/lib/infra-map.ts`)

```ts
/** Selected node + transitive ancestors + transitive descendants (siblings stay out). */
export function highlightClosure(graph: MapGraph, selectedId: string): Set<string> {
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!down.has(e.source)) down.set(e.source, []);
    down.get(e.source)!.push(e.target);
    if (!up.has(e.target)) up.set(e.target, []);
    up.get(e.target)!.push(e.source);
  }
  const out = new Set<string>([selectedId]);
  const walk = (start: string, dir: Map<string, string[]>) => {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of dir.get(n) ?? []) if (!out.has(m)) { out.add(m); stack.push(m); }
    }
  };
  walk(selectedId, up);
  walk(selectedId, down);
  return out;
}

/** Case-insensitive substring match over id/label/sub/badge + all meta leaf values. */
export function searchMatches(graph: MapGraph, query: string): Set<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) return new Set();
  const hit = (v: unknown): boolean =>
    typeof v === 'string' ? v.toLowerCase().includes(needle)
    : typeof v === 'number' ? String(v).includes(needle)
    : Array.isArray(v) ? v.some(hit)
    : v !== null && typeof v === 'object' ? Object.values(v).some(hit)
    : false;
  return new Set(
    graph.nodes
      .filter((n) =>
        n.id.toLowerCase().includes(needle) ||
        n.label.toLowerCase().includes(needle) ||
        (n.sub ?? '').toLowerCase().includes(needle) ||
        (n.badge ?? '').toLowerCase().includes(needle) ||
        hit(n.meta))
      .map((n) => n.id),
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/infra-map.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/infra-map.ts web/lib/infra-map.test.ts
git commit -m "feat(topology): closure highlight + multi-field search for map graphs"
```

---

### Task 3: `ingresses` in-cluster kind + `normalizeIngress`

**Files:**
- Modify: `web/lib/eks-incluster.ts`
- Test: `web/lib/eks-incluster.test.ts` (append)

**Interfaces:**
- Consumes: existing `K8sItem`, `age()`, `KIND_PATH`, `isKind`, `NORMALIZERS` internals of `eks-incluster.ts`.
- Produces (used by Task 4, 7):
  - `type Kind` gains `'ingresses'`; `isKind('ingresses') === true`; `KIND_PATH.ingresses === '/apis/networking.k8s.io/v1/ingresses'`.
  - `interface IngressRow { name: string; namespace: string; className: string; lbHostname: string; backends: { service: string; port: string }[]; age: string }`
  - `function normalizeIngress(it: K8sItem): IngressRow`

Read-only GET; routing metadata only — no secret-bearing fields (allow-list invariant intact).
The incluster route (`app/api/eks/[cluster]/incluster/route.ts`) gates on `isKind` and needs no change.

- [ ] **Step 1: Write the failing tests** (append to `web/lib/eks-incluster.test.ts`, following the file's existing normalizer-test style)

```ts
import { normalizeIngress, isKind } from './eks-incluster';

describe('ingresses kind', () => {
  it('is an allowed kind', () => {
    expect(isKind('ingresses')).toBe(true);
  });

  it('normalizeIngress carries class, LB hostname, and deduped backends (rules + defaultBackend)', () => {
    const row = normalizeIngress({
      metadata: { name: 'web', namespace: 'prod', creationTimestamp: new Date(Date.now() - 3600_000).toISOString() },
      spec: {
        ingressClassName: 'alb',
        defaultBackend: { service: { name: 'fallback', port: { number: 80 } } },
        rules: [
          { http: { paths: [
            { backend: { service: { name: 'web-svc', port: { number: 8080 } } } },
            { backend: { service: { name: 'web-svc', port: { number: 8080 } } } }, // dup → 1
          ] } },
        ],
      },
      status: { loadBalancer: { ingress: [{ hostname: 'k8s-abc.elb.amazonaws.com' }] } },
    } as never);
    expect(row.name).toBe('web');
    expect(row.namespace).toBe('prod');
    expect(row.className).toBe('alb');
    expect(row.lbHostname).toBe('k8s-abc.elb.amazonaws.com');
    expect(row.backends).toEqual([
      { service: 'fallback', port: '80' },
      { service: 'web-svc', port: '8080' },
    ]);
  });

  it('normalizeIngress tolerates missing spec/status', () => {
    const row = normalizeIngress({ metadata: { name: 'bare', namespace: 'ns' } } as never);
    expect(row.backends).toEqual([]);
    expect(row.lbHostname).toBe('');
    expect(row.className).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/eks-incluster.test.ts`
Expected: FAIL — `normalizeIngress` not exported / `isKind('ingresses')` false.

- [ ] **Step 3: Implement in `web/lib/eks-incluster.ts`**

1. Extend the `Kind` union: add `| 'ingresses'` (with a comment: `// gap-audit L164 K8s map — networking.k8s.io, read-only GET`).
2. `KIND_PATH`: add `ingresses: '/apis/networking.k8s.io/v1/ingresses',`.
3. `isKind`: add `|| k === 'ingresses'` following the existing pattern.
4. Extend `K8sItem` types (optional fields only):
   - `spec` gains `ingressClassName?: string; defaultBackend?: IngressBackend; rules?: { http?: { paths?: { backend?: IngressBackend }[] } }[]`
   - `status` gains `loadBalancer?: { ingress?: { hostname?: string; ip?: string }[] }`
   - add above `K8sItem`: `interface IngressBackend { service?: { name?: string; port?: { number?: number; name?: string } } }`
5. Row type + normalizer + registration:

```ts
export interface IngressRow {
  name: string; namespace: string; className: string; lbHostname: string;
  backends: { service: string; port: string }[]; age: string;
}

export function normalizeIngress(it: K8sItem): IngressRow {
  const backends: { service: string; port: string }[] = [];
  const push = (b?: { service?: { name?: string; port?: { number?: number; name?: string } } }) => {
    const s = b?.service;
    if (s?.name) backends.push({ service: s.name, port: String(s.port?.number ?? s.port?.name ?? '') });
  };
  push(it.spec?.defaultBackend);
  for (const r of it.spec?.rules ?? []) for (const p of r.http?.paths ?? []) push(p.backend);
  const seen = new Set<string>();
  const deduped = backends.filter((b) => {
    const k = `${b.service}:${b.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const lb = it.status?.loadBalancer?.ingress?.[0];
  return {
    name: it.metadata?.name ?? '',
    namespace: it.metadata?.namespace ?? '',
    className: it.spec?.ingressClassName ?? '',
    lbHostname: lb?.hostname ?? lb?.ip ?? '',
    backends: deduped,
    age: age(it.metadata?.creationTimestamp),
  };
}
```

6. Register: `NORMALIZERS`-style map (`ingresses: normalizeIngress`) and add `IngressRow` to the exported row union type (line ~219).

- [ ] **Step 4: Run to verify pass + full lib file suite**

Run: `npx vitest run lib/eks-incluster.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add web/lib/eks-incluster.ts web/lib/eks-incluster.test.ts
git commit -m "feat(eks): read-only ingresses in-cluster kind for the K8s map"
```

---

### Task 4: `web/lib/k8s-map.ts` — `buildK8sMap()`

**Files:**
- Create: `web/lib/k8s-map.ts`
- Test: `web/lib/k8s-map.test.ts`

**Interfaces:**
- Consumes: `MapGraph`/`MapNode`/`MapEdge` from `./infra-map` (Task 1); row types `IngressRow` (Task 3), `ServiceRow`, `EndpointRow` from `./eks-incluster`; `PodRow`, `NodeRow` from `./eks-resources`.
- Produces (used by Task 7):
  - `interface K8sMapInput { ingresses: IngressRow[]; services: ServiceRow[]; pods: PodRow[]; nodes: NodeRow[]; endpoints: EndpointRow[] }`
  - `function buildK8sMap(input: K8sMapInput): MapGraph`

Columns: 0 Ingress, 1 Service, 2 Pod, 3 Node. Ids: `ing:${ns}/${name}`, `svc:${ns}/${name}`,
`pod:${ns}/${name}`, `node:${name}`. Edges: ingress backends → same-namespace service;
service → pod via endpoints (endpoint ns+name == service ns+name; its `ips[]` joined to
`pods[].podIP` in the same namespace); pod → node via `pod.node`.

- [ ] **Step 1: Write the failing test**

`web/lib/k8s-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildK8sMap, type K8sMapInput } from './k8s-map';
import { highlightClosure } from './infra-map';

const base = (): K8sMapInput => ({
  ingresses: [{ name: 'web', namespace: 'prod', className: 'alb', lbHostname: 'k8s-x.elb.amazonaws.com', backends: [{ service: 'web-svc', port: '8080' }], age: '1h' }],
  services: [
    { name: 'web-svc', namespace: 'prod', type: 'ClusterIP', clusterIP: '172.20.0.10', ports: '8080/TCP', age: '1h' },
    { name: 'web-svc', namespace: 'dev', type: 'ClusterIP', clusterIP: '172.20.9.9', ports: '8080/TCP', age: '1h' },
  ],
  pods: [
    { name: 'web-1', namespace: 'prod', status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, podIP: '10.0.2.10' },
    { name: 'lonely', namespace: 'prod', status: 'Pending', node: '', restarts: 0, age: '1m', cpuRequest: 0, memRequest: 0, diskRequest: 0 },
  ],
  nodes: [{ name: 'node-a', status: 'Ready', roles: '', version: 'v1.31', instanceType: 'm7g.large', zone: 'apne2-a', age: '9d', cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 16384, memAllocatable: 15000, diskCapacity: 0, diskAllocatable: 0 }],
  endpoints: [{ name: 'web-svc', namespace: 'prod', ips: ['10.0.2.10'] }],
});

describe('buildK8sMap', () => {
  it('assigns 4 columns and namespaced ids', () => {
    const g = buildK8sMap(base());
    const col = (id: string) => g.nodes.find((n) => n.id === id)?.column;
    expect(col('ing:prod/web')).toBe(0);
    expect(col('svc:prod/web-svc')).toBe(1);
    expect(col('pod:prod/web-1')).toBe(2);
    expect(col('node:node-a')).toBe(3);
  });

  it('draws ingress→service, service→pod (endpoints IP join), pod→node edges', () => {
    const g = buildK8sMap(base());
    const has = (s: string, t: string) => g.edges.some((e) => e.source === s && e.target === t);
    expect(has('ing:prod/web', 'svc:prod/web-svc')).toBe(true);
    expect(has('svc:prod/web-svc', 'pod:prod/web-1')).toBe(true);
    expect(has('pod:prod/web-1', 'node:node-a')).toBe(true);
  });

  it('does not cross-join same-name services in different namespaces', () => {
    const g = buildK8sMap(base());
    expect(g.edges.some((e) => e.source === 'ing:prod/web' && e.target === 'svc:dev/web-svc')).toBe(false);
    expect(g.edges.some((e) => e.source === 'svc:dev/web-svc')).toBe(false); // no prod-IP leakage
  });

  it('keeps pods with no service or node (rendered edge-less to node column only)', () => {
    const g = buildK8sMap(base());
    expect(g.nodes.some((n) => n.id === 'pod:prod/lonely')).toBe(true);
    expect(g.edges.some((e) => e.target === 'pod:prod/lonely' || e.source === 'pod:prod/lonely')).toBe(false);
  });

  it('closure highlight walks the full 4-column chain', () => {
    const g = buildK8sMap(base());
    const hl = highlightClosure(g, 'svc:prod/web-svc');
    for (const id of ['ing:prod/web', 'pod:prod/web-1', 'node:node-a']) expect(hl.has(id)).toBe(true);
    expect(hl.has('pod:prod/lonely')).toBe(false);
  });

  it('carries useful card fields (status/badge/sub)', () => {
    const g = buildK8sMap(base());
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node('ing:prod/web').sub).toContain('k8s-x.elb.amazonaws.com');
    expect(node('svc:prod/web-svc').sub).toContain('172.20.0.10');
    expect(node('pod:prod/web-1').status).toBe('ok');      // Running
    expect(node('pod:prod/lonely').status).toBe('warn');    // Pending
    expect(node('node:node-a').status).toBe('ok');          // Ready
    expect(node('node:node-a').badge).toContain('1 pod');   // pod count
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/k8s-map.test.ts`
Expected: FAIL — cannot resolve `./k8s-map`.

- [ ] **Step 3: Implement**

`web/lib/k8s-map.ts`:

```ts
// Pure MapGraph builder for the K8s 4-column map (gap-audit L164):
// Ingress → Service → Pod → Node. React-free (vitest).
import type { MapGraph, MapNode, MapEdge } from './infra-map';
import type { IngressRow, ServiceRow, EndpointRow } from './eks-incluster';
import type { PodRow, NodeRow } from './eks-resources';

export interface K8sMapInput {
  ingresses: IngressRow[]; services: ServiceRow[]; pods: PodRow[];
  nodes: NodeRow[]; endpoints: EndpointRow[];
}

const POD_STATUS: Record<string, MapNode['status']> = {
  Running: 'ok', Succeeded: 'ok', Pending: 'warn', Failed: 'bad', Unknown: 'warn',
};

export function buildK8sMap(input: K8sMapInput): MapGraph {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const bySort = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

  const svcIds = new Set(input.services.map((s) => `svc:${s.namespace}/${s.name}`));
  const podByIp = new Map<string, PodRow[]>();
  for (const p of input.pods) {
    if (!p.podIP) continue;
    const k = `${p.namespace}|${p.podIP}`;
    if (!podByIp.has(k)) podByIp.set(k, []);
    podByIp.get(k)!.push(p);
  }
  const nodeNames = new Set(input.nodes.map((n) => n.name));

  // column 0 — Ingress
  for (const ing of [...input.ingresses].sort(bySort((i) => `${i.namespace}/${i.name}`))) {
    const id = `ing:${ing.namespace}/${ing.name}`;
    nodes.push({
      id, kind: 'ingress', column: 0, label: ing.name,
      sub: ing.lbHostname || ing.className, badge: `${ing.namespace}${ing.className ? ` · ${ing.className}` : ''}`,
      status: 'neutral', meta: { ...ing },
    });
    for (const b of ing.backends) {
      const svcId = `svc:${ing.namespace}/${b.service}`;
      if (svcIds.has(svcId)) edges.push({ source: id, target: svcId });
    }
  }

  // column 1 — Service (+ service→pod via same-namespace Endpoints IP join)
  for (const svc of [...input.services].sort(bySort((s) => `${s.namespace}/${s.name}`))) {
    const id = `svc:${svc.namespace}/${svc.name}`;
    nodes.push({
      id, kind: 'service', column: 1, label: svc.name,
      sub: `${svc.type} · ${svc.clusterIP}`, badge: svc.namespace, status: 'neutral', meta: { ...svc },
    });
    const ep = input.endpoints.find((e) => e.namespace === svc.namespace && e.name === svc.name);
    for (const ip of ep?.ips ?? []) {
      for (const p of podByIp.get(`${svc.namespace}|${ip}`) ?? []) {
        edges.push({ source: id, target: `pod:${p.namespace}/${p.name}` });
      }
    }
  }

  // column 2 — Pod (+ pod→node)
  for (const p of [...input.pods].sort(bySort((x) => `${x.namespace}/${x.name}`))) {
    const id = `pod:${p.namespace}/${p.name}`;
    nodes.push({
      id, kind: 'pod', column: 2, label: p.name,
      sub: p.podIP || p.status, badge: p.namespace,
      status: POD_STATUS[p.status] ?? 'neutral', meta: { ...p },
    });
    if (p.node && nodeNames.has(p.node)) edges.push({ source: id, target: `node:${p.node}` });
  }

  // column 3 — Node (badge: pods placed on it)
  const podCount = new Map<string, number>();
  for (const p of input.pods) if (p.node) podCount.set(p.node, (podCount.get(p.node) ?? 0) + 1);
  for (const n of [...input.nodes].sort(bySort((x) => x.name))) {
    const count = podCount.get(n.name) ?? 0;
    nodes.push({
      id: `node:${n.name}`, kind: 'node', column: 3, label: n.name,
      sub: `${n.instanceType} · ${n.zone}`, badge: `${count} pod${count === 1 ? '' : 's'}`,
      status: n.status === 'Ready' ? 'ok' : 'warn', meta: { ...n },
    });
  }

  return { nodes, edges };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/k8s-map.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/k8s-map.ts web/lib/k8s-map.test.ts
git commit -m "feat(topology): K8s 4-column MapGraph builder (ingress→service→pod→node)"
```

---

### Task 5: `web/components/topology/MapCanvas.tsx` — shared ReactFlow renderer

**Files:**
- Create: `web/components/topology/MapCanvas.tsx`

**Interfaces:**
- Consumes: `MapGraph`, `MapNode`, `MapKind`, `highlightClosure`, `searchMatches` (Tasks 1–2).
- Produces (used by Tasks 6–7):
  - `export default function MapCanvas(props: { graph: MapGraph; columns: { title: string }[]; query: string; theme: 'light' | 'dark'; onSelect?: (node: MapNode | null) => void }): JSX.Element`
  - Selection state is internal (click toggles; click same node or the "선택 해제" chip clears; `onSelect` reports for detail use).

No unit test (DOM/ReactFlow rendering) — the gate is `npx tsc --noEmit -p .` plus the page-level manual check in Task 8; all displayed values come from the tested builders.

- [ ] **Step 1: Implement the component**

```tsx
'use client';

// Shared ReactFlow renderer for columnar MapGraphs (infra map / K8s map).
// Layout is deterministic: x from column index, y from per-column stacking order.
import { useMemo, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Position, type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { highlightClosure, searchMatches, type MapGraph, type MapKind, type MapNode } from '@/lib/infra-map';

const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });
const Background = dynamic(() => import('@xyflow/react').then((m) => m.Background), { ssr: false });
const Controls = dynamic(() => import('@xyflow/react').then((m) => m.Controls), { ssr: false });

const COL_X = 340;      // column pitch
const CARD_W = 260;
const ROW_H = 84;       // vertical pitch inside a column
const TITLE_Y = -70;

// kind → [light bg, light border, dark bg, dark border]
const KIND_COLORS: Record<MapKind, [string, string, string, string]> = {
  igw:     ['#E6F6EC', '#2E9E5B', '#0E2E1C', '#2E9E5B'],
  tgw:     ['#F1E9FF', '#8A5BD0', '#241A3E', '#8A5BD0'],
  vpc:     ['#E7EDFB', '#4F6BED', '#161F3E', '#4F6BED'],
  subnet:  ['#EAF3EE', '#3F9D6B', '#12271B', '#3F9D6B'],
  ec2:     ['#FEF3E2', '#C8902F', '#33260C', '#C8902F'],
  alb:     ['#FDF0E0', '#B7791F', '#302108', '#B7791F'],
  nlb:     ['#FDF0E0', '#B7791F', '#302108', '#B7791F'],
  rds:     ['#E6EEFE', '#3D6FB5', '#16243E', '#3D6FB5'],
  nat:     ['#FDECE8', '#C85A45', '#331410', '#C85A45'],
  ingress: ['#FDECE8', '#C85A45', '#331410', '#C85A45'],
  service: ['#E6EEFE', '#3D6FB5', '#16243E', '#3D6FB5'],
  pod:     ['#EAF3EE', '#3F9D6B', '#12271B', '#3F9D6B'],
  node:    ['#F1E9FF', '#8A5BD0', '#241A3E', '#8A5BD0'],
};
const STATUS_DOT: Record<NonNullable<MapNode['status']>, string> = {
  ok: '#01A88D', warn: '#F59E0B', bad: '#D13212', neutral: '#9AA6B2',
};

export const KIND_LABELS: Partial<Record<MapKind, string>> = {
  igw: 'IGW', tgw: 'TGW', vpc: 'VPC', subnet: 'Subnet', ec2: 'EC2', alb: 'ALB',
  nlb: 'NLB', rds: 'RDS', nat: 'NAT', ingress: 'Ingress', service: 'Service', pod: 'Pod', node: 'Node',
};

/** Legend chips for the kinds present in a graph. */
export function MapLegend({ graph, theme }: { graph: MapGraph; theme: 'light' | 'dark' }) {
  const kinds = [...new Set(graph.nodes.map((n) => n.kind))];
  return (
    <>
      {kinds.map((k) => {
        const [lb, lbo, db, dbo] = KIND_COLORS[k];
        return (
          <span key={k} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: theme === 'dark' ? db : lb, border: `1px solid ${theme === 'dark' ? dbo : lbo}` }}
            />
            {KIND_LABELS[k] ?? k}
          </span>
        );
      })}
    </>
  );
}

interface CardData extends Record<string, unknown> { mapNode: MapNode; theme: 'light' | 'dark' }

function CardNode({ data }: NodeProps) {
  const { mapNode: n, theme } = data as CardData;
  const [lb, lbo, db, dbo] = KIND_COLORS[n.kind];
  const [bg, border] = theme === 'dark' ? [db, dbo] : [lb, lbo];
  return (
    <div
      className="rounded-lg px-2.5 py-1.5"
      style={{ width: CARD_W, background: bg, border: `1.5px solid ${border}`, color: theme === 'dark' ? '#E8EDF2' : '#16202A' }}
    >
      <div className="flex items-center gap-1.5">
        {n.status && <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_DOT[n.status] }} />}
        <span className="truncate text-[12px] font-semibold" title={n.label}>{n.label}</span>
        {n.badge && (
          <span className="ml-auto shrink-0 rounded px-1 text-[9px]" style={{ border: `1px solid ${border}` }}>{n.badge}</span>
        )}
      </div>
      {n.sub && <div className="truncate text-[10px] opacity-75" title={n.sub}>{n.sub}</div>}
    </div>
  );
}
const nodeTypes = { card: CardNode };

export default function MapCanvas({ graph, columns, query, theme, onSelect }:
  { graph: MapGraph; columns: { title: string }[]; query: string; theme: 'light' | 'dark'; onSelect?: (node: MapNode | null) => void }) {
  const [selected, setSelected] = useState<string | null>(null);

  const lit = useMemo(() => {
    if (selected && graph.nodes.some((n) => n.id === selected)) return highlightClosure(graph, selected);
    const m = searchMatches(graph, query);
    return m.size > 0 ? m : null; // null → nothing dimmed
  }, [graph, selected, query]);

  const { nodes, edges } = useMemo(() => {
    const stack: number[] = columns.map(() => 0);
    const nodes: Node[] = graph.nodes.map((n) => {
      const y = stack[n.column]++ * ROW_H;
      return {
        id: n.id,
        type: 'card',
        position: { x: n.column * COL_X, y },
        data: { mapNode: n, theme } satisfies CardData,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: { opacity: lit && !lit.has(n.id) ? 0.22 : 1 },
      };
    });
    // Column titles as static nodes so they pan/zoom with the canvas.
    columns.forEach((c, i) => {
      nodes.push({
        id: `__col${i}`, type: 'default', position: { x: i * COL_X, y: TITLE_Y }, draggable: false, selectable: false,
        data: { label: c.title },
        style: {
          width: CARD_W, background: 'transparent', border: 'none', boxShadow: 'none',
          fontSize: 13, fontWeight: 700, color: theme === 'dark' ? '#AFBAC3' : '#586773', textAlign: 'center' as const,
        },
      });
    });
    const edges: Edge[] = graph.edges.map((e, i) => {
      const on = !lit || (lit.has(e.source) && lit.has(e.target));
      return {
        id: `e${i}:${e.source}->${e.target}`, source: e.source, target: e.target,
        type: 'smoothstep',
        style: { stroke: theme === 'dark' ? '#586773' : '#9AA6B2', opacity: on ? 0.9 : 0.12, strokeWidth: on && lit ? 1.8 : 1.2 },
      };
    });
    return { nodes, edges };
  }, [graph, columns, lit, theme]);

  const handleNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.id.startsWith('__col')) return;
    setSelected((cur) => {
      const next = cur === node.id ? null : node.id;
      onSelect?.(next ? graph.nodes.find((n) => n.id === next) ?? null : null);
      return next;
    });
  }, [graph, onSelect]);

  return (
    <div className="relative min-h-0 flex-1">
      {selected && (
        <button
          onClick={() => { setSelected(null); onSelect?.(null); }}
          className="absolute right-3 top-3 z-10 rounded-md border border-ink-200 bg-card px-2 py-1 text-[11px] hover:bg-ink-50"
        >
          선택 해제
        </button>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={() => { setSelected(null); onSelect?.(null); }}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.05}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

Note: `MapLegend` and `KIND_LABELS` are named exports; the component itself is the default export (repo rule).

- [ ] **Step 2: Typecheck**

Run (from `web/`): `npx tsc --noEmit -p .`
Expected: clean. (`useTheme` isn't used here — the page passes `theme` down; verify the actual hook name in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add web/components/topology/MapCanvas.tsx
git commit -m "feat(topology): shared columnar ReactFlow MapCanvas (cards, closure dim, legend)"
```

---

### Task 6: `InfraMapView` — fetch + assemble the 5-column view

**Files:**
- Create: `web/components/topology/InfraMapView.tsx`

**Interfaces:**
- Consumes: `buildInfraMap`, `InvRow`, `TgwAttachmentLite` (Task 1); `MapCanvas`, `MapLegend` (Task 5); `useActiveAccount`/`accountParam` from `@/lib/account-context`; `useTheme` from `@/lib/use-theme` (check its exact return shape in `web/lib/use-theme.ts` — the topology page at `web/app/topology/page.tsx` already uses it; mirror that usage).
- Produces: `export default function InfraMapView(props: { query: string }): JSX.Element` (used by Task 8's page toggle).

- [ ] **Step 1: Implement**

```tsx
'use client';

// 5-column infra map (gap-audit L163): External | VPC | Subnet | Compute | NAT.
// Data = existing /api/inventory/[type] reads only; TGW→VPC attachments via /api/tgw.
import { useEffect, useMemo, useState } from 'react';
import MapCanvas, { MapLegend } from '@/components/topology/MapCanvas';
import { buildInfraMap, type InvRow, type TgwAttachmentLite } from '@/lib/infra-map';
import { useActiveAccount, accountParam } from '@/lib/account-context';
import { useTheme } from '@/lib/use-theme';

const TYPES = ['internet_gateway', 'transit_gateway', 'vpc', 'subnet', 'ec2', 'alb', 'nlb', 'rds', 'nat_gateway'] as const;
type MapType = (typeof TYPES)[number];
const COLUMNS = [{ title: 'External' }, { title: 'VPC' }, { title: 'Subnet' }, { title: 'Compute' }, { title: 'NAT' }];
const LIMIT = 500;

interface InvPage { rows?: { resource_id: string; region: string | null; data: Record<string, unknown> }[]; total?: number }

export default function InfraMapView({ query }: { query: string }) {
  const [activeAccount] = useActiveAccount();
  const theme = useTheme();
  const [rows, setRows] = useState<Partial<Record<MapType, InvRow[]>> | null>(null);
  const [tgwAtt, setTgwAtt] = useState<TgwAttachmentLite[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [capped, setCapped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBusy(true);
    const acct = accountParam(activeAccount);
    Promise.all(TYPES.map(async (t) => {
      try {
        const r = await fetch(`/api/inventory/${t}?limit=${LIMIT}${acct ? `&${acct}` : ''}`);
        if (!r.ok) throw new Error(String(r.status));
        const page: InvPage = await r.json();
        return [t, page.rows ?? [], (page.total ?? 0) > LIMIT] as const;
      } catch {
        return [t, null, false] as const;
      }
    })).then(async (results) => {
      if (!live) return;
      const out: Partial<Record<MapType, InvRow[]>> = {};
      const fails: string[] = [];
      const caps: string[] = [];
      for (const [t, r, wasCapped] of results) {
        if (r === null) fails.push(t);
        else { out[t] = r; if (wasCapped) caps.push(t); }
      }
      setRows(out);
      setFailed(fails);
      setCapped(caps);
      setBusy(false);
      // TGW attachments (live describe) — degrade to edge-less TGW nodes on failure.
      const tgwIds = (out.transit_gateway ?? []).map((r) => r.resource_id).filter((id) => /^tgw-[0-9a-f]+$/.test(id));
      if (tgwIds.length > 0) {
        try {
          const r = await fetch(`/api/tgw?ids=${tgwIds.join(',')}`);
          if (r.ok) {
            const d: { attachments?: { tgwId: string; resourceType: string; resourceId: string }[] } = await r.json();
            if (live) setTgwAtt((d.attachments ?? []).map((a) => ({ tgwId: a.tgwId, resourceType: a.resourceType, resourceId: a.resourceId })));
          }
        } catch { /* edge-less TGW nodes */ }
      }
    });
    return () => { live = false; };
  }, [activeAccount]);

  const graph = useMemo(() => rows && buildInfraMap({
    igw: rows.internet_gateway ?? [], tgw: rows.transit_gateway ?? [], vpc: rows.vpc ?? [],
    subnet: rows.subnet ?? [], ec2: rows.ec2 ?? [], alb: rows.alb ?? [], nlb: rows.nlb ?? [],
    rds: rows.rds ?? [], nat: rows.nat_gateway ?? [], tgwAttachments: tgwAtt,
  }), [rows, tgwAtt]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-ink-500">
        {busy && <span>불러오는 중…</span>}
        {failed.length > 0 && <span className="text-red-600">조회 실패: {failed.join(', ')}</span>}
        {capped.length > 0 && <span className="text-amber-600">500행 초과로 일부만 표시: {capped.join(', ')}</span>}
        {graph && <span>노드 {graph.nodes.length.toLocaleString()} · 엣지 {graph.edges.length.toLocaleString()}</span>}
        {graph && <MapLegend graph={graph} theme={theme} />}
        {graph && graph.nodes.length === 0 && !busy && <span>표시할 네트워크 리소스가 없습니다 (인벤토리 sync 확인).</span>}
      </div>
      {graph && graph.nodes.length > 0 && (
        <MapCanvas graph={graph} columns={COLUMNS} query={query} theme={theme} />
      )}
    </div>
  );
}
```

Adjustment rules while implementing (verify, don't assume):
- `useTheme()` return shape: open `web/lib/use-theme.ts` and match how `web/app/topology/page.tsx` derives `'light' | 'dark'` — if it returns an object, adapt the two `theme` usages accordingly.
- `InvPage.total`: open `web/lib/inventory.ts` `readResources` return type; if the page response has no `total` field, drop the `capped` computation and instead flag `rows.length === LIMIT` as capped.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/components/topology/InfraMapView.tsx
git commit -m "feat(topology): infra map view — 9-type inventory fetch + tgw attachments"
```

---

### Task 7: `K8sMapView` — cluster selector + 5-kind fetch

**Files:**
- Create: `web/components/topology/K8sMapView.tsx`

**Interfaces:**
- Consumes: `buildK8sMap` (Task 4); row types from `@/lib/eks-incluster` / `@/lib/eks-resources`; `MapCanvas`, `MapLegend` (Task 5). Cluster list: `GET /api/eks` → `{ clusters: { name: string; connected?: boolean; … }[] }` (check `web/app/api/eks/route.ts` rows for the exact connected-flag field and filter to clusters the map can read).
- Produces: `export default function K8sMapView(props: { query: string }): JSX.Element` (used by Task 8).

- [ ] **Step 1: Implement**

```tsx
'use client';

// K8s 4-column map (gap-audit L164): Ingress | Service | Pod | Node, per registered cluster.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import MapCanvas, { MapLegend } from '@/components/topology/MapCanvas';
import { buildK8sMap } from '@/lib/k8s-map';
import type { IngressRow, ServiceRow, EndpointRow } from '@/lib/eks-incluster';
import type { PodRow, NodeRow } from '@/lib/eks-resources';
import { useTheme } from '@/lib/use-theme';

const COLUMNS = [{ title: 'Ingress' }, { title: 'Service' }, { title: 'Pod' }, { title: 'Node' }];
const KINDS = ['ingresses', 'services', 'pods', 'nodes', 'endpoints'] as const;

export default function K8sMapView({ query }: { query: string }) {
  const theme = useTheme();
  const [clusters, setClusters] = useState<string[] | null>(null);
  const [cluster, setCluster] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<{ ingresses: IngressRow[]; services: ServiceRow[]; pods: PodRow[]; nodes: NodeRow[]; endpoints: EndpointRow[] } | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/eks')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { clusters?: { name: string }[] }) => {
        if (!live) return;
        const names = (d.clusters ?? []).map((c) => c.name);
        setClusters(names);
        if (names.length > 0) setCluster((cur) => cur || names[0]);
      })
      .catch((e) => { if (live) { setClusters([]); setErr(String(e instanceof Error ? e.message : e)); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!cluster) return;
    let live = true;
    setBusy(true);
    setErr('');
    Promise.all(KINDS.map(async (kind) => {
      const r = await fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=${kind}`);
      const d = await r.json();
      if (!r.ok) throw new Error(String(d?.message ?? r.status));
      return d.rows as unknown[];
    }))
      .then(([ingresses, services, pods, nodes, endpoints]) => {
        if (live) setData({
          ingresses: ingresses as IngressRow[], services: services as ServiceRow[],
          pods: pods as PodRow[], nodes: nodes as NodeRow[], endpoints: endpoints as EndpointRow[],
        });
      })
      .catch((e) => { if (live) { setData(null); setErr(String(e instanceof Error ? e.message : e)); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [cluster]);

  const graph = useMemo(() => data && buildK8sMap(data), [data]);

  if (clusters !== null && clusters.length === 0 && !err) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-ink-500">
        <span>등록된 EKS 클러스터가 없습니다 — <Link href="/eks" className="text-brand-700 underline">/eks에서 클러스터를 등록</Link>하세요.</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-ink-500">
        <select
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
          className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]"
        >
          {(clusters ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {busy && <span>불러오는 중…</span>}
        {err && <span className="text-red-600">조회 실패: {err}</span>}
        {graph && <span>노드 {graph.nodes.length.toLocaleString()} · 엣지 {graph.edges.length.toLocaleString()}</span>}
        {graph && <MapLegend graph={graph} theme={theme} />}
        {graph && graph.nodes.length === 0 && !busy && <span>클러스터에 표시할 리소스가 없습니다.</span>}
      </div>
      {graph && graph.nodes.length > 0 && (
        <MapCanvas graph={graph} columns={COLUMNS} query={query} theme={theme} />
      )}
    </div>
  );
}
```

Adjustment rule: `/api/eks` cluster rows carry connection metadata (see `web/app/api/eks/route.ts` — `{ clusters: rows, admin }`); if rows expose a connected/access flag, filter the selector to connected clusters so the first fetch doesn't 502 on an unregistered cluster.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/components/topology/K8sMapView.tsx
git commit -m "feat(topology): K8s map view — cluster selector + 5-kind in-cluster fetch"
```

---

### Task 8: Page toggle on `/topology/infra` + CHANGELOG + suite + PR

**Files:**
- Modify: `web/app/topology/infra/page.tsx`
- Modify: `CHANGELOG.md` (repo root)

**Interfaces:**
- Consumes: `InfraMapView` (Task 6), `K8sMapView` (Task 7). Existing graph-view code stays in this file, extracted into a local `GraphView` function component (move lines 38–147 of the current file body — state, fetch, memos, ReactFlow render — verbatim; only the `PageHeader` stays in the page shell).
- Produces: the user-facing feature.

View state: `?view=graph|map|k8s` via `useSearchParams` + `router.replace` (default `graph`).
The search input in the header stays shared: `GraphView` keeps its existing node-match semantics;
map views receive `query` as a prop (Tasks 6–7 accept it).

- [ ] **Step 1: Restructure the page**

```tsx
// Page shell sketch (keep the existing GraphView logic verbatim inside GraphView()):
export default function InfraTopologyPage() {
  const router = useRouter();
  const params = useSearchParams();
  const view = (params.get('view') === 'map' || params.get('view') === 'k8s') ? params.get('view')! : 'graph';
  const [q, setQ] = useState('');
  const setView = (v: string) => router.replace(`/topology/infra${v === 'graph' ? '' : `?view=${v}`}`);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="인프라 배치 그래프"
        subtitle={view === 'k8s'
          ? 'Ingress → Service → Pod → Node 컬럼 맵. 노드 클릭으로 교차 하이라이트.'
          : view === 'map'
            ? 'External | VPC | Subnet | Compute | NAT 컬럼 맵. 노드 클릭으로 교차 하이라이트.'
            : '계정 전체 리소스-관계 토폴로지 (VPC · Subnet · SG · 리소스). 노드 검색으로 하이라이트.'}
        right={
          <div className="flex items-center gap-3 text-[12px] text-ink-600">
            <div className="flex overflow-hidden rounded-md border border-ink-200">
              {([['graph', '배치 그래프'], ['map', '인프라 맵'], ['k8s', 'K8s 맵']] as const).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-2 py-1 ${view === v ? 'bg-brand-600 text-white' : 'bg-card hover:bg-ink-50'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="검색 (id · 이름 · IP · 타입)…"
              className="w-56 rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            />
            <Link href="/topology" className="rounded-md border border-ink-200 bg-card px-2 py-1 hover:bg-ink-50">← 트래픽 흐름</Link>
          </div>
        }
      />
      {view === 'graph' && <GraphView q={q} />}
      {view === 'map' && <InfraMapView query={q} />}
      {view === 'k8s' && <K8sMapView query={q} />}
    </div>
  );
}
```

Notes:
- `GraphView` receives `q` as a prop instead of owning the input (the header now owns it); its internal `matches` memo is unchanged.
- `useSearchParams` in App Router requires a `<Suspense>` boundary at build time — wrap the page body: `export default function Page() { return <Suspense fallback={null}><InfraTopologyPageInner /></Suspense> }` (check how other pages in the repo using `useSearchParams` handle this — e.g. grep `useSearchParams` under `web/app/` and mirror).

- [ ] **Step 2: Typecheck + full test suite** (from `web/`)

Run: `npx tsc --noEmit -p .` then `npm test`
Expected: both clean (no regressions in the 200+ test files).

- [ ] **Step 3: CHANGELOG entry**

`CHANGELOG.md` `[Unreleased]` — one bullet per feature, both `# English` and `# 한국어` sections (1:1), no PR/round numbers:

- English `### Added`: `- Topology infra page gains two columnar map views — a 5-column infra resource map (External | VPC | Subnet | Compute | NAT) and a per-cluster K8s map (Ingress → Service → Pod → Node) — with click cross-highlighting, search highlighting, and a color legend.`
- 한국어 `### 추가됨`: `- 토폴로지 인프라 페이지에 컬럼형 맵 뷰 2종 추가 — 5컬럼 인프라 리소스 맵(External | VPC | Subnet | Compute | NAT)과 클러스터별 K8s 맵(Ingress → Service → Pod → Node), 클릭 교차 하이라이트·검색 하이라이트·색상 범례 포함.`

- [ ] **Step 4: Commit**

```bash
git add web/app/topology/infra/page.tsx CHANGELOG.md
git commit -m "feat(topology): infra map + k8s map view toggle on /topology/infra"
```

- [ ] **Step 5: Push + PR**

```bash
gh repo set-default Atom-oh/awsops
git push -u origin feat/infra-map-view
gh pr create --title "feat(topology): columnar infra map + K8s map views (gap-audit L163/L164/L248)" --body "$(cat <<'EOF'
## Summary
- 5-column infra resource map (External | VPC | Subnet | Compute | NAT) as a view toggle on /topology/infra — existing inventory reads only, click cross-highlight, search highlight, color legend
- K8s 4-column map (Ingress → Service → Pod → Node) per registered cluster — adds the read-only `ingresses` in-cluster kind
- Spec: docs/superpowers/specs/2026-08-28-infra-map-view-design.md

Closes gap-audit items L163 / L164 / L248 (docs/v1-gap-audit-2026-07-19.md).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Tick the gap-audit checkboxes** — in a follow-up commit on this branch, mark L163/L164/L248 `- [x]` in `docs/v1-gap-audit-2026-07-19.md` (they ship with this PR).

```bash
git add docs/v1-gap-audit-2026-07-19.md
git commit -m "docs(gap-audit): mark topology map view items shipped"
git push
```
