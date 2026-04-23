# EKS/Kubernetes 페이지 / EKS & Kubernetes Pages

## 역할 / Role
EKS 클러스터·노드·Pod·Deployment·Service 뷰 + K9s 스타일 터미널 탐색기. kubeconfig 등록은 상위 `/api/k8s` 라우트에서 수행.
(EKS cluster/node/pod/deployment/service views plus a K9s-style terminal explorer. Kubeconfig registration lives in `/api/k8s`.)

## 주요 파일 / Key Files
- `page.tsx` — EKS Overview (클러스터, 노드, Pod 요약, Access Entry 상태)
- `explorer/page.tsx` — K9s 스타일 터미널 UI (네임스페이스 필터, 리소스 테이블, 상세 패널)
- `pods/page.tsx` — Pod 목록 (네임스페이스 필터, 상태/재시작/노드)
- `nodes/page.tsx` — 노드 목록 (CPU/메모리/ENI, 인스턴스 타입, AZ)
- `deployments/page.tsx` — Deployment (replicas, 이미지, 롤아웃 상태)
- `services/page.tsx` — Service (type, ClusterIP, LoadBalancer 엔드포인트) — 클릭 가능한 네비게이션 + 노드 ENI 트래픽 메트릭

## 공유 컴포넌트 / Shared Components
`src/components/k8s/`의 4개 컴포넌트 활용: `K9sResourceTable`, `K9sDetailPanel`, `K9sClusterHeader`, `NamespaceFilter`.

## 데이터 소스 / Data Sources
- Steampipe `kubernetes` 플러그인 (60+ 테이블) — Pod, Node, Deployment, Service, Event
- Steampipe `trivy` 플러그인 (CVE)
- `/api/k8s/route.ts` — kubeconfig 등록 (EKS Access Entry)
- OpenCost API — `/eks-container-cost` 페이지에서 사용 (본 페이지는 제외)

## 규칙 / Rules
- 모든 쿼리는 `buildSearchPath(accountId)` 기반 — 계정별 K8s 연결
- 멀티 클러스터: Steampipe `kubernetes.context` 컬럼으로 구분
- SQL 인젝션 방지: `nodeName`, ENI ID 등 사용자 입력은 화이트리스트 검증 후 인터폴레이션
- `warningEvents` 쿼리는 `involved_object_kind`, `involved_object_name`, `count` 컬럼 필수
- `k8s` feature flag (`features.eksEnabled`, `features.k8sEnabled`) 비활성 계정에서는 페이지 자체를 Sidebar에서 숨김

---

# EKS / Kubernetes Pages (English summary)

Cluster overview plus pod/node/deployment/service views and a K9s-style terminal explorer at `explorer/`.

Rules:
- Queries go through `buildSearchPath(accountId)` for per-account K8s connections.
- Multi-cluster disambiguation uses Steampipe's `kubernetes.context` column.
- Sanitize `nodeName` / ENI IDs before SQL interpolation to prevent injection.
- Accounts without `features.eksEnabled`/`features.k8sEnabled` hide these pages in the Sidebar.
