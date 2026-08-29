# Infra Map View + K8s Map — columnar graph views on /topology/infra
# 인프라 Map View + K8s 맵 — /topology/infra 컬럼형 그래프 뷰

**Status:** Approved 2026-08-28. Branch `feat/infra-map-view`.
Closes gap-audit items: topology 5-column Infra Map (L163), topology K8s Map (L164), topology legend (L248) — `docs/v1-gap-audit-2026-07-19.md`.

## 요약 (한국어)

v1의 기본 토폴로지 화면이던 **5컬럼 인프라 리소스 맵**(External[IGW·TGW] | VPC | Subnet |
Compute[EC2·ALB/NLB·RDS] | NAT)과 **K8s 리소스 맵**(Ingress → Service → Pod → Node 4컬럼)을
v2 `/topology/infra` 페이지의 뷰 토글로 복원한다. v1은 순수 DOM 컬럼이었으나, v2는 사용자 요청에
따라 **ReactFlow 캔버스 위 고정 컬럼 레이아웃 + 실제 엣지 연결선**으로 렌더링한다(커스텀 노드 카드,
containment/attachment 엣지, 교차 하이라이트, 타입별 색상 범례). 데이터는 전부 기존 API만 사용:
인프라 맵은 `/api/inventory/[type]`(9개 타입 모두 Aurora sync 완료), K8s 맵은
`/api/eks/[cluster]/incluster`(단, `ingresses` kind 1종을 read-only allow-list에 추가).
**신규 백엔드 라우트·테이블·Terraform 변경 없음.**

## Problem

v2's `/topology/infra` renders the account-wide infra graph as a free-form ReactFlow layout
(VPC/Subnet/SG/resource nodes from the materialized `class='infra'` graph). Two v1 views are
missing (gap audit L163/L164):

1. **Infra Map** — a fixed 5-column placement map (External | VPCs | Subnets | Compute | NAT)
   where clicking a VPC highlights its member subnets + compute and dims everything else,
   clicking an EC2 highlights its parent subnet + VPC, with select-toggle and clear-selection.
2. **K8s Map** — a 4-column map (Ingress | Services | Pods | Nodes) with edges derived from
   ingress rules → service, service → pod, pod → node, per selected cluster.

Also L248: no color legend explaining node kinds.

## Decisions

### Placement: view toggle on `/topology/infra`

Three views on the existing page, selected by a segmented toggle (no new sidebar entry):

- **배치 그래프** (existing) — the current ReactFlow materialized-graph view, unchanged.
- **인프라 맵** (new) — 5-column map.
- **K8s 맵** (new) — 4-column map with a cluster selector (host-account `connected` clusters only — the in-cluster read path is host-scoped, so member-account clusters are not listed).

The toggle state lives in the URL (`?view=graph|map|k8s`) so links/refresh preserve the view.

### Rendering: ReactFlow with fixed column layout (user request: "실제 graph가 보이는 이쁜 frontend")

Both new views render on a ReactFlow canvas (already a dependency, client-only dynamic import
like the existing pages) with:

- **Fixed column x-positions** computed by a pure layout function (no dagre) — nodes stack
  vertically within their column in a deterministic sort: subnets by (vpc, az, name), compute
  by (vpc, subnet, kind, name), NAT by (vpc, subnet), so vertical proximity implies membership.
  No per-VPC banding in this iteration — edges carry the membership signal.
- **Custom node cards** (`nodeTypes`): icon + name + secondary line (CIDR / AZ badge /
  instance type / engine) + status dot (EC2 state, NAT state, ALB state). Subnets with
  `map_public_ip_on_launch` get an `auto-public-ip` badge (the flag governs auto-assign public
  IP, not IGW reachability).
- **Edges**: containment/attachment drawn as real edges — IGW→VPC, TGW→VPC (attachment,
  via the live `GET /api/tgw?ids=` describe; degrade to edge-less TGW nodes on failure),
  VPC→Subnet, Subnet→EC2/ALB/NLB (subnet membership; multi-subnet resources like ALB get
  one edge per subnet), VPC→RDS (the synced rds row carries `vpc_id` but no subnet ids —
  only `db_subnet_group_name`), Subnet→NAT. K8s: Ingress→Service (rule backend), Service→Pod
  (endpoints IP join), Pod→Node (`spec.nodeName`). TGW attachments resolve to a VPC node only
  when the raw VPC id maps to exactly ONE scope (ambiguous multi-scope matches are skipped,
  never guessed), and failed/deleting attachments draw no edge; a failed `/api/tgw` fetch
  surfaces a warning chip instead of rendering edge-less TGWs as unattached. The describe
  itself reports per-region failures (`degradedRegions`) so a region-level AWS error also
  surfaces as a chip rather than rendering as "unattached".
- **Cross-highlight**: clicking a node computes its closure (ancestors + descendants along
  edges) — closure nodes/edges stay full opacity, the rest dim to ~0.25. Clicking the selected
  node again (or a Clear button) resets. Search box highlights all matching nodes
  (name/id/IP/type substring) the same way, consistent with the existing graph view.
- **Legend**: color-swatch chips for the active view's kinds (Infra: IGW/TGW/VPC/Subnet/
  EC2/ALB·NLB/RDS/NAT · K8s: Ingress/Service/Pod/Node) — closes L248 for the new views.

### Data: existing reads only

- **Infra Map** fetches `/api/inventory/[type]` for `internet_gateway`, `transit_gateway`,
  `vpc`, `subnet`, `ec2`, `alb`, `nlb`, `rds`, `nat_gateway` (parallel, `limit=500` each,
  `accounts` param from `useActiveAccount` — account scoping for free). A `capped` note is
  shown when any type hits the 500-row page limit (consistent with the audit's known
  ROW_LIMIT caveat; no pagination in v1 either).
- **K8s Map** fetches `/api/eks/[cluster]/incluster?kind=` for `ingresses` (new),
  `services`, `pods`, `nodes`, `endpoints`.

### New in-cluster kind: `ingresses`

`web/lib/eks-incluster.ts` gains `ingresses: '/apis/networking.k8s.io/v1/ingresses'` in
`KIND_PATH` + `isKind` + a `normalizeIngress` that carries: `name`, `namespace`,
`className` (`spec.ingressClassName`), `lbHostname` (first `status.loadBalancer.ingress[]`
hostname/ip), `backends` (deduped `{serviceName, port}[]` from `spec.rules[].http.paths[].backend.service`
plus `spec.defaultBackend`), `age`. Read-only GET, consistent with the pinned allow-list
invariant (secrets stay rejected; no data values carried beyond routing metadata).

### Module layout (pure logic separated for TDD)

- `web/lib/infra-map.ts` — `buildInfraMap(rows: InfraMapInput): MapGraph` where `MapGraph =
  { nodes: MapNode[], edges: MapEdge[] }`, `MapNode = { id, kind, column, label, sub?, badge?,
  status?, meta }`. Node ids are account/region-scoped via `invNodeId(kind, row)`
  (`` `${kind}:${account}/${region}/${resource_id}` ``) — `inventory_resources`' key spans
  account/region and ALB/NLB resource_ids are bare names, so unscoped ids would collide.
  Also `highlightClosure(graph, selectedId): Set<string>` and
  `searchMatches(graph, query): Set<string>` (matches label/id/meta values incl. IPs and
  instance types). No React imports.
- `web/lib/k8s-map.ts` — `buildK8sMap({ ingresses, services, pods, nodes, endpoints }):
  MapGraph` (same shape; service→pod join: endpoints row (namespace+name == service) → ips →
  pods by `podIP`; fallback: no endpoints match → no edge, pod still listed).
- `web/components/topology/MapCanvas.tsx` — shared ReactFlow renderer: takes a `MapGraph`,
  column definitions (title, color), selection/search state; computes x from column index,
  y from stacking order; renders custom card nodes + legend + clear-selection chip.
- `web/app/topology/infra/page.tsx` — adds the view toggle, the two new views' fetch logic,
  and the cluster selector for K8s view. Existing graph view code untouched.

### Error handling

- Per-type inventory fetch failures degrade per column (failed kinds show an inline error
  chip; the rest of the map still renders).
- K8s view: no registered clusters → empty-state with a link to `/eks`; incluster fetch
  error (cluster unreachable / RBAC) → the route's error message surfaces in the pane
  (same pattern as the EKS explorer page).
- Empty account (0 VPCs) → explicit empty-state text, not a blank canvas.

### Testing

Vitest, colocated:
- `web/lib/infra-map.test.ts` — column assignment per kind; IGW/TGW→VPC, VPC→Subnet,
  Subnet→resource, Subnet→NAT edges; multi-subnet ALB fan-out; missing subnet/vpc ids
  (edge dropped, node kept); highlight closure up (EC2→Subnet→VPC) and down
  (VPC→Subnets→EC2s incl. edges); search matches IP/instance-type/meta; public-subnet badge.
- `web/lib/k8s-map.test.ts` — ingress backends→service edges (rules + defaultBackend,
  dedup); service→pod via endpoints IP join; pod→node; cross-namespace isolation
  (same-name services in different namespaces don't cross-join); pods with no service
  still render; closure highlight across 4 columns.
- `web/lib/eks-incluster.test.ts` — extend: `isKind('ingresses')`, `normalizeIngress`
  (rules + defaultBackend + missing status), KIND_PATH URL.
- Page-level rendering is covered by typecheck + existing patterns (no page snapshot tests
  in this repo's convention for topology pages).

## Out of scope

- No changes to the materialized graph (`/api/graph`), graph rebuild, or `topology_nodes/edges`.
- No Terraform/IAM changes (in-cluster access reuses the existing Access Entry AdminView path).
- No i18n expansion beyond the strings this page already handles (ko-first like its siblings).
- TGW route-table drill-down (separate gap item) stays out.
