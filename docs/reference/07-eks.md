# 07. EKS Onboarding — v2 Reference

## Purpose / 목적

**EN** — Grant the v2 web task role read-only access to host-account EKS clusters so the dashboard can query Kubernetes resources. Onboarding discovers clusters interactively, validates each cluster's auth mode, and provisions an EKS Access Entry + **AdminView** policy through Terraform. Cluster connection info (endpoint/CA) is exposed as a Terraform output, and **the Kubernetes query UI already consumes it** — `web/app/eks/` (fleet overview + per-cluster detail + OpenCost panel), not a deferred P3 item.

**KO** — v2 웹 태스크 역할에 호스트 계정 EKS 클러스터에 대한 읽기 전용 접근을 부여하여, 대시보드가 Kubernetes 리소스를 조회할 수 있게 한다. 온보딩은 클러스터를 대화식으로 탐색하고 각 클러스터의 인증 모드를 검증한 뒤, Terraform으로 EKS Access Entry + **AdminView** 정책을 프로비저닝한다. 클러스터 연결 정보(endpoint/CA)는 Terraform output으로 노출되며, **Kubernetes 조회 UI가 이미 이를 소비한다** — `web/app/eks/`(클러스터 목록 + 클러스터별 상세 + OpenCost 패널), P3로 연기된 항목이 아니다.

## Current design / 현행 설계

**EN**
- `scripts/v2/configure.mjs` offers an **EKS multi-select** during `make configure`:
  - Discovers clusters via `eks:ListClusters` (`listEksClusters`).
  - Runs an **auth-mode preflight** per cluster (`eksAuthMode`): clusters in `API`/`API_AND_CONFIG_MAP` are selectable; `CONFIG_MAP`-only clusters are listed in a handoff message (Access Entry unavailable).
  - Writes the selection as `onboard_eks_clusters = [...]` into `terraform.tfvars`.
- `terraform/v2/foundation/eks.tf` iterates that list with `for_each = toset(var.onboard_eks_clusters)`:
  - `aws_eks_access_entry.web` — registers the web task role (`awsops-v2-task`) as a `STANDARD` principal on each cluster.
  - `aws_eks_access_policy_association.web_view` — binds the AWS-managed **`AmazonEKSAdminViewPolicy`** (NOT plain `AmazonEKSViewPolicy` — the resource is misleadingly named `web_view` but binds AdminView) at **cluster** scope. Plain View mirrors the k8s `view` ClusterRole and has **no cluster-scoped resources — listing nodes 403s**; AdminView grants `*/*/get,list,watch`. The BFF (`web/lib/eks-incluster.ts`) enforces its own kind allow-list (nodes/pods/deployments/services/namespaces/events) behind this — secrets/configmaps never transit.
  - `aws_iam_role_policy.task_eks` — grants the task role `eks:DescribeCluster` / `eks:ListClusters` / `eks:DescribeAccessEntry` (created only when the list is non-empty).
  - `data.aws_eks_cluster.onboard` + `output "onboarded_eks_clusters"` — exposes endpoint / ARN / CA data per cluster, consumed by the already-live query UI (`web/app/eks/`).
  - `eks_auto_register_enabled` (requires `workers_enabled`) additionally wires a CloudTrail → EventBridge → Lambda (`scripts/v2/eks/auto_register.py`) flow: when an operator manually associates an access policy on a *new* cluster via CLI, it's auto-(un)registered into the Aurora `eks_registrations` table — no button needed, and no new AWS-resource mutation (observation-only automation).
- **Host-account only.** Empty default list → `for_each` over an empty set creates nothing (safe no-op until a cluster is selected).

**KO**
- `scripts/v2/configure.mjs`는 `make configure` 중 **EKS 멀티 선택**을 제공한다:
  - `eks:ListClusters`로 클러스터 탐색.
  - 클러스터별 **인증 모드 사전 점검**: `API`/`API_AND_CONFIG_MAP`은 선택 가능, `CONFIG_MAP` 전용은 핸드오프 목록으로 안내(Access Entry 불가).
  - 선택 결과를 `onboard_eks_clusters = [...]`로 `terraform.tfvars`에 기록.
- `terraform/v2/foundation/eks.tf`는 `for_each`로 해당 목록을 순회: Access Entry + 클러스터 스코프 **AdminView**(단순 View 아님 — View는 cluster-scoped 리소스가 없어 노드 목록 403) 정책 + 태스크 역할 IAM + 클러스터 연결 정보 output(이미 LIVE인 조회 UI가 소비).
  - `eks_auto_register_enabled`(`workers_enabled` 선행) 시 CloudTrail→EventBridge→Lambda가 신규 클러스터의 access-policy 연계를 감지해 Aurora `eks_registrations`에 자동 (역)등록 — 버튼 불필요, AWS 리소스 변경 아님(관찰-전용).
- **호스트 계정 전용.** 기본값이 빈 목록이면 아무 리소스도 생성되지 않는다(안전한 no-op).

## Decisions (ADRs) / 결정

**EN** — No dedicated ADR exists for EKS onboarding (a documentation gap). Onboarding inherits the multi-account model of [ADR-011](../../decisions/011-multi-account.md), but here it is **host-account only** — cross-account assume-role onboarding is intentionally excluded. **Kubeconfig auto-registration and the Kubernetes query UI are already LIVE, not deferred** — see Key files/Status below.

**KO** — EKS 온보딩 전용 ADR은 없다(문서 공백). [ADR-011](../../decisions/011-multi-account.md)의 멀티 계정 모델을 계승하지만 여기서는 **호스트 계정 전용**이며, 교차 계정 assume-role 온보딩은 의도적으로 제외했다. **kubeconfig 자동 등록과 Kubernetes 조회 UI는 이미 LIVE**이며 연기된 항목이 아니다 — 아래 Key files/Status 참조.

## Key files / 핵심 파일

| File / 파일 | Role / 역할 |
|---|---|
| `terraform/v2/foundation/eks.tf` | `onboard_eks_clusters` var, Access Entry, **AdminView** policy association, task-role EKS IAM, `onboarded_eks_clusters` output, `eks_auto_register_enabled`-gated CloudTrail→Lambda auto-registration |
| `scripts/v2/configure.mjs` | EKS discovery (`listEksClusters`) + auth-mode preflight (`eksAuthMode`) + multi-select → tfvars |
| `web/app/eks/page.tsx` + `web/app/eks/[cluster]/page.tsx` | **Live** query UI — fleet overview + per-cluster detail (node/pod/event rendering) + OpenCost panel |
| `web/lib/eks-registry.ts` | Runtime cluster allow-list = env (`ONBOARDED_EKS_CLUSTERS`) ∪ Aurora `eks_registrations`; `registerCluster`/`unregisterCluster` |
| `web/lib/eks-incluster.ts` | In-cluster read proxy with a kind allow-list (nodes/pods/deployments/services/namespaces/events) — secrets/configmaps rejected by test |

## Status / 상태

**EN** — **P1e ✅ done, and the "P3" query UI has since shipped too.** `fsi-demo-cluster` onboarded and verified:
- Access entry principal = `awsops-v2-task`.
- `AmazonEKSAdminViewPolicy` associated at cluster scope (not plain View — see Current design).
- `onboarded_eks_clusters` output returns endpoint / ARN / CA.
- Host clusters are all in `API_AND_CONFIG_MAP` auth mode, so Access Entry works without flipping any cluster.
- **Beyond P1e**: the Kubernetes query UI (`web/app/eks/`) and `eks_auto_register_enabled` runtime registration are live, not deferred.

**KO** — **P1e ✅ 완료, 그리고 "P3"로 적혀있던 조회 UI도 이미 배포됨.** `fsi-demo-cluster` 온보딩 및 검증 완료(access entry = `awsops-v2-task`, **AdminView** 정책, endpoint/ARN/CA output). 호스트 클러스터는 모두 `API_AND_CONFIG_MAP` 모드라 클러스터 전환 없이 Access Entry가 동작한다. **P1e 이후**: Kubernetes 조회 UI(`web/app/eks/`)와 `eks_auto_register_enabled` 런타임 등록이 이미 LIVE.

## Learnings & gotchas / 학습·함정

**EN**
- **OpenCost = read-only out-of-band install bundle.** The UI generates a bundle the operator runs themselves; AWS-resource mutation stays **FROZEN (ADR-005, do-not-enable)** — NOT an in-app mutating action.
- **Multi-account is excluded** — host account only for P1e.
- **The web code already consumes the `onboarded_eks_clusters` output — this shipped, it's not a P3 IOU.** `web/app/eks/` builds on it directly for the live query UI.
- `for_each` over the empty default list creates zero resources, so merging `eks.tf` is a safe no-op until a cluster is selected in tfvars.
- The correct CA attribute is `data.aws_eks_cluster.onboard[*].certificate_authority[0].data`.
- **`web_view` binds AdminView, not View** — the Terraform resource name is historical/misleading; grep `policy_arn` in `eks.tf` before trusting the resource name.

**KO**
- **OpenCost = read-only out-of-band 설치 번들.** UI가 번들을 생성하고 운영자가 직접 실행; AWS-리소스 변경은 **FROZEN (ADR-005, do-not-enable)** — 인앱 변경 액션 아님.
- **멀티 계정 제외** — P1e는 호스트 계정 전용.
- **웹 코드는 이미 `onboarded_eks_clusters` output을 소비한다 — P3 IOU가 아니라 이미 배포됨.** `web/app/eks/`가 이를 바로 사용해 조회 UI를 제공한다.
- **`web_view`는 AdminView를 바인딩** — Terraform 리소스 이름이 오해를 유발하니 이름만 믿지 말고 `eks.tf`의 `policy_arn`을 직접 확인할 것.
- 빈 기본 목록에 대한 `for_each`는 리소스를 생성하지 않으므로 `eks.tf` 병합은 안전한 no-op이다.
- CA 속성은 `certificate_authority[0].data`가 정확하다.

## Source / 출처

- `docs/superpowers/archive/2026-05-31-awsops-v2-p1e-eks-onboarding.md` (the P1e plan, after archival)
