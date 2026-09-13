// Client-safe K8s resource types + pure parsing/aggregation.
// CRITICAL: this module must have NO server-only imports (no node:https, no @aws-sdk).
// eks-incluster.ts (server) imports from here; 'use client' pages import from here too,
// so the browser bundle never pulls in the server STS/HTTPS code.

export interface NodeCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
}

export interface NodeTaint {
  key: string;
  value: string;
  effect: string;
}

export interface NodeRow {
  name: string; status: string; roles: string; version: string; instanceType: string; zone: string; age: string;
  // capacity/allocatable: cpu in cores, memory in MiB (0 when the API didn't report it).
  cpuCapacity: number; cpuAllocatable: number; memCapacity: number; memAllocatable: number;
  // Actual metrics-server usage: cores / MiB, null when unavailable; timestamp of the sample.
  cpuUsage?: number | null; memUsage?: number | null; usageTimestamp?: string | null;
  // ephemeral-storage capacity/allocatable in MiB (0 when the API didn't report it).
  diskCapacity: number; diskAllocatable: number;
  // Detail-only metadata for node drilldowns. Secrets are never included here.
  labels?: Record<string, string>;
  taints?: NodeTaint[];
  conditions?: NodeCondition[];
  /** v1 parity (node capacity card): the node's pod CIDR + creation timestamp. */
  podCIDR?: string;
  createdAt?: string;
}
export interface PodRow {
  name: string; namespace: string; status: string; node: string; restarts: number; age: string;
  // summed container requests: cpu in cores, memory in MiB, ephemeral-storage in MiB.
  cpuRequest: number; memRequest: number; diskRequest: number;
  // for topology: pod IP (matches an ALB/NLB target IP) + owning workload (Deployment/etc.).
  podIP?: string; workload?: string;
  // v1 node-detail parity (gap L226): the pod's service account ('' when the API omits it).
  serviceAccount?: string;
  // metadata.labels (gap L229): the Service-selector join side. Non-secret metadata; omitted
  // when empty.
  labels?: Record<string, string>;
}

// Kubernetes quantities use the same decimal/binary suffixes for cores and bytes.
const QUANTITY_EXPONENT: Record<string, number> = {
  '': 0, n: -9, u: -6, m: -3, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18,
  Ki: 10, Mi: 20, Gi: 30, Ti: 40, Pi: 50, Ei: 60,
};

/** Strict quantity parsing for measurements: missing/invalid/negative is unknown, not zero. */
function parseUsageQuantity(quantity: unknown): number | null {
  if (typeof quantity !== 'string' && typeof quantity !== 'number') return null;
  const match = String(quantity).trim().match(/^(\+?(?:\d+(?:\.\d*)?|\.\d+))([numkMGTPE]|[KMGTPE]i|[eE][+-]?\d+)?$/);
  if (!match) return null;
  const magnitude = Number(match[1]);
  const suffix = match[2] ?? '';
  const exponent = QUANTITY_EXPONENT[suffix] ?? Number(suffix.slice(1));
  const base = suffix.endsWith('i') ? 2 : 10;
  const value = exponent < 0 ? magnitude / base ** -exponent : magnitude * base ** exponent;
  return Number.isFinite(value) && !(magnitude > 0 && value === 0) ? value : null;
}

/** Actual CPU usage in cores, retaining nano/microcore precision and explicit zero. */
export function parseCpuUsage(cpu: unknown): number | null {
  return parseUsageQuantity(cpu);
}

/** Actual memory working set in MiB, without request/capacity rounding. */
export function parseMemUsage(mem: unknown): number | null {
  const bytes = parseUsageQuantity(mem);
  return bytes === null ? null : bytes / (1024 * 1024);
}

/** Parse a K8s CPU quantity to cores, including n/u/m suffixes; unknown requests → 0. */
export function parseCpuCores(cpu: unknown): number {
  if (cpu == null || cpu === '') return 0;
  const s = String(cpu).trim();
  if (s.endsWith('n')) return (parseFloat(s) || 0) / 1e9;
  if (s.endsWith('u')) return (parseFloat(s) || 0) / 1e6;
  if (s.endsWith('m')) return (parseFloat(s) || 0) / 1000;
  return parseFloat(s) || 0;
}

/**
 * Parse a K8s memory quantity to MiB: "32986188Ki"→32213, "512Mi"→512, "2Gi"→2048.
 * K8s quantity semantics (P4 gate: codex): binary suffixes (Ki/Mi/Gi/Ti) are
 * 1024-based, decimal suffixes (k/K/M/G/T) are 1000-based BYTES, and a bare
 * number is plain BYTES — not MiB. ""/null/unparseable → 0.
 */
export function parseMem(mem: unknown): number {
  if (mem == null || mem === '') return 0;
  const s = String(mem).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|k|K|M|G|T)?$/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const MI = 1024 * 1024;
  switch (m[2] ?? '') {
    case 'Ki': return Math.round(v / 1024);
    case 'Mi': return Math.round(v);
    case 'Gi': return Math.round(v * 1024);
    case 'Ti': return Math.round(v * 1024 * 1024);
    case 'k': case 'K': return Math.round((v * 1e3) / MI);
    case 'M': return Math.round((v * 1e6) / MI);
    case 'G': return Math.round((v * 1e9) / MI);
    case 'T': return Math.round((v * 1e12) / MI);
    default: return Math.round(v / MI); // bare quantity = bytes
  }
}

export interface NodeResourceAgg {
  name: string;
  instanceType: string;
  cpuUsage?: number | null; memUsage?: number | null; usageTimestamp?: string | null;
  cpuAllocatable: number; cpuRequest: number; cpuPct: number;
  memAllocatable: number; memRequest: number; memPct: number;
  diskAllocatable: number; diskRequest: number; diskPct: number;
  podCount: number;
}

/** Terminal phases hold no scheduler reservation (Succeeded/Failed — kubectl parity). */
export function isTerminalPodPhase(status: unknown): boolean {
  return status === 'Succeeded' || status === 'Failed';
}

/**
 * Aggregate pod requests per node against node allocatable.
 * Pods are matched to a node by PodRow.node === NodeRow.name. reqPct is clamped 0..100
 * (0 when allocatable is 0/unknown). Nodes with no scheduled pods report zeros.
 */
export function aggregateNodeResources(nodes: NodeRow[], pods: PodRow[]): NodeResourceAgg[] {
  const byNode = new Map<string, { cpu: number; mem: number; disk: number; count: number }>();
  for (const p of pods) {
    if (!p.node) continue;
    // Terminal pods keep spec.nodeName + requests but release the reservation — including
    // them overstates Requested on Job/CronJob-churning clusters (kubectl describe node
    // excludes them). The scheduler-reservation claim requires the same exclusion.
    if (isTerminalPodPhase(p.status)) continue;
    const e = byNode.get(p.node) ?? { cpu: 0, mem: 0, disk: 0, count: 0 };
    e.cpu += p.cpuRequest || 0;
    e.mem += p.memRequest || 0;
    e.disk += p.diskRequest || 0;
    e.count += 1;
    byNode.set(p.node, e);
  }
  const pct = (req: number, alloc: number) => (alloc > 0 ? Math.min(100, Math.round((req / alloc) * 100)) : 0);
  return nodes.map((n) => {
    const e = byNode.get(n.name) ?? { cpu: 0, mem: 0, disk: 0, count: 0 };
    return {
      name: n.name,
      instanceType: n.instanceType,
      cpuUsage: n.cpuUsage ?? null, memUsage: n.memUsage ?? null, usageTimestamp: n.usageTimestamp ?? null,
      cpuAllocatable: n.cpuAllocatable, cpuRequest: e.cpu, cpuPct: pct(e.cpu, n.cpuAllocatable),
      memAllocatable: n.memAllocatable, memRequest: e.mem, memPct: pct(e.mem, n.memAllocatable),
      diskAllocatable: n.diskAllocatable, diskRequest: e.disk, diskPct: pct(e.disk, n.diskAllocatable),
      podCount: e.count,
    };
  });
}

/**
 * Count nodes per instanceType, blank → 'unknown', sorted by count desc
 * (ties broken by type name for stable output).
 */
export function instanceTypeDistribution(nodes: NodeRow[]): { type: string; count: number }[] {
  const m = new Map<string, number>();
  for (const n of nodes) {
    const type = n.instanceType || 'unknown';
    m.set(type, (m.get(type) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
