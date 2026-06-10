// Client-safe K8s resource types + pure parsing/aggregation.
// CRITICAL: this module must have NO server-only imports (no node:https, no @aws-sdk).
// eks-incluster.ts (server) imports from here; 'use client' pages import from here too,
// so the browser bundle never pulls in the server STS/HTTPS code.

export interface NodeRow {
  name: string; status: string; roles: string; version: string; instanceType: string; zone: string; age: string;
  // capacity/allocatable: cpu in cores, memory in MiB (0 when the API didn't report it).
  cpuCapacity: number; cpuAllocatable: number; memCapacity: number; memAllocatable: number;
}
export interface PodRow {
  name: string; namespace: string; status: string; node: string; restarts: number; age: string;
  // summed container requests: cpu in cores, memory in MiB.
  cpuRequest: number; memRequest: number;
}

/** Parse a K8s CPU quantity to cores: "8"→8, "7910m"→7.91, ""/null→0. */
export function parseCpuCores(cpu: unknown): number {
  if (cpu == null || cpu === '') return 0;
  const s = String(cpu).trim();
  if (s.endsWith('m')) return (parseFloat(s) || 0) / 1000;
  return parseFloat(s) || 0;
}

/** Parse a K8s memory quantity to MiB: "32986188Ki"→32213, "512Mi"→512, "2Gi"→2048, ""/null→0. */
export function parseMem(mem: unknown): number {
  if (mem == null || mem === '') return 0;
  const s = String(mem).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti)?$/i);
  if (!m) return parseInt(s, 10) || 0;
  let v = parseFloat(m[1]);
  const u = (m[2] || '').toLowerCase();
  if (u === 'ki') v = v / 1024;
  else if (u === 'gi') v = v * 1024;
  else if (u === 'ti') v = v * 1024 * 1024;
  // 'mi' or none → already MiB
  return Math.round(v);
}

export interface NodeResourceAgg {
  name: string;
  cpuAllocatable: number; cpuRequest: number; cpuPct: number;
  memAllocatable: number; memRequest: number; memPct: number;
  podCount: number;
}

/**
 * Aggregate pod requests per node against node allocatable.
 * Pods are matched to a node by PodRow.node === NodeRow.name. reqPct is clamped 0..100
 * (0 when allocatable is 0/unknown). Nodes with no scheduled pods report zeros.
 */
export function aggregateNodeResources(nodes: NodeRow[], pods: PodRow[]): NodeResourceAgg[] {
  const byNode = new Map<string, { cpu: number; mem: number; count: number }>();
  for (const p of pods) {
    if (!p.node) continue;
    const e = byNode.get(p.node) ?? { cpu: 0, mem: 0, count: 0 };
    e.cpu += p.cpuRequest || 0;
    e.mem += p.memRequest || 0;
    e.count += 1;
    byNode.set(p.node, e);
  }
  const pct = (req: number, alloc: number) => (alloc > 0 ? Math.min(100, Math.round((req / alloc) * 100)) : 0);
  return nodes.map((n) => {
    const e = byNode.get(n.name) ?? { cpu: 0, mem: 0, count: 0 };
    return {
      name: n.name,
      cpuAllocatable: n.cpuAllocatable, cpuRequest: e.cpu, cpuPct: pct(e.cpu, n.cpuAllocatable),
      memAllocatable: n.memAllocatable, memRequest: e.mem, memPct: pct(e.mem, n.memAllocatable),
      podCount: e.count,
    };
  });
}
