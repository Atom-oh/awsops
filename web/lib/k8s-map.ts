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
      sub: ing.lbHostname || ing.className,
      badge: `${ing.namespace}${ing.className ? ` · ${ing.className}` : ''}`,
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
