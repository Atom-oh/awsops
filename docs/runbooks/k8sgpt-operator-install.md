# Runbook: K8sGPT Operator Installation

This is **operator/cluster-admin work**, outside AWSops. AWSops reads Result CRDs; it does not install
controllers, grant access, or apply fixes. `k8sgpt_enabled` defaults false and is analysis-only under
ADR-006. No command below authorizes enabling ADR-005 remediation.

Repository checked **2026-09-13**. This checkout pins the adapter contract to
`ADAPTER_K8SGPT_VERSION = '0.4.x/result.core.k8sgpt.ai/v1'`; it does **not** pin an installable Helm
chart release. Select a compatible, reviewed chart/image pair before installation; do not use "latest."

## When to use this runbook

Use when an onboarded cluster's K8sGPT panel has no operator/results or cannot read them.
Check the feature gate before diagnosing missing CRDs: when off, the route returns 503 without
cluster reads. An installed operator does not prove AWSops enablement or compatible output.

## Diagnosis

```bash
kubectl config current-context
kubectl get pods -n k8sgpt-operator-system
kubectl get crd results.result.core.k8sgpt.ai
kubectl get results.result.core.k8sgpt.ai -A
```

Check operator/image/CRD version against `web/lib/k8sgpt-adapter.ts` and its fixtures. Missing results,
forbidden reads, and incompatible schemas are different failures. Avoid copying raw Result data into
shared logs; anonymization is not complete redaction of events, configuration, or workload metadata.

## Compatibility review — installation remains gated

ADR-006 Decision 5 currently requires an operator ClusterRole limited to get/list/watch,
with create/update/patch/delete denied. A controller that publishes Result CRs or manages
reconciliation objects may require writes. That is an unresolved compatibility conflict,
not permission for this runbook to redefine the accepted boundary.

This checkout pins the reader adapter contract, not an approved Helm chart/image pair.
Do not install or enable a write-capable controller on the authority of this document.
First establish a configuration satisfying the accepted boundary, or obtain a separately
approved ADR amendment through the project's policy process. Neither this review nor the
operator/non-product distinction silently grants an exception.

The following commands inspect a selected version locally; they do not install it:

```bash
set -euo pipefail
: "${PINNED_OPERATOR_VERSION:?Set a candidate compatible Helm chart version for review}"
helm repo add k8sgpt https://charts.k8sgpt.ai/
helm repo update k8sgpt
helm show chart k8sgpt/k8sgpt-operator --version "$PINNED_OPERATOR_VERSION"
helm show values k8sgpt/k8sgpt-operator --version "$PINNED_OPERATOR_VERSION" \
  > /tmp/awsops-k8sgpt-values.yaml
helm template k8sgpt-operator k8sgpt/k8sgpt-operator --include-crds \
  --namespace k8sgpt-operator-system --version "$PINNED_OPERATOR_VERSION" \
  > /tmp/awsops-k8sgpt-rendered.yaml
```

Inspect rendered RBAC and the selected release's CRD before accepting any configuration.
No anonymization control is set by these inspection commands. Do not rely on unverified
`deployAnonymized`, `ai.anonymized`, or `ai.autoRemediation` fields: an unsupported field
may be ignored. Keep AI credentials, external sinks, fix mode and automatic remediation
absent/disabled in any subsequently approved configuration, and verify the rendered values
against that pinned release. Never send raw Results to an external model on an assumption
that anonymization is active. Existing controllers are not retroactively approved here.

## Action — AWSops Result-read access

The current host web Access Entry in `terraform/v2/foundation/eks.tf` uses
`AmazonEKSAdminViewPolicy`, not the older View-only description, and defines no Kubernetes group.
Inspect the actual access entry/policy; do not bind an invented group name and assume it maps to AWSops.

```bash
: "${AWS_REGION:?Set the cluster region}"
: "${K8SGPT_CLUSTER:?Set the onboarded cluster name}"
: "${AWSOPS_WEB_ROLE_ARN:?Set the actual web task role ARN}"
aws eks describe-access-entry --region "$AWS_REGION" --cluster-name "$K8SGPT_CLUSTER" \
  --principal-arn "$AWSOPS_WEB_ROLE_ARN"
aws eks list-associated-access-policies --region "$AWS_REGION" --cluster-name "$K8SGPT_CLUSTER" \
  --principal-arn "$AWSOPS_WEB_ROLE_ARN"
```

If additional Kubernetes RBAC is needed, the cluster owner can bind an **actually mapped** group to
this Result-reader role. Establishing/changing that mapping is a separate operator access change.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: awsops-k8sgpt-result-reader
rules:
  - apiGroups: ["result.core.k8sgpt.ai"]
    resources: ["results"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: awsops-k8sgpt-result-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: awsops-k8sgpt-result-reader
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: "<ACTUAL_MAPPED_KUBERNETES_GROUP>"
```

## Validate Result-read access

Use an isolated kubeconfig authenticated as the actual AWSops principal. A successful
cluster-admin read or group impersonation alone does not prove the EKS IAM mapping works.
Do not widen a role's trust policy merely to run this check.

```bash
: "${AWSOPS_KUBECONFIG:?Set an isolated kubeconfig using the actual AWSops principal}"
kubectl --kubeconfig "$AWSOPS_KUBECONFIG" auth can-i list results.result.core.k8sgpt.ai --all-namespaces
kubectl --kubeconfig "$AWSOPS_KUBECONFIG" get results.result.core.k8sgpt.ai -A -o json \
  | jq '{items: [.items[] | {apiVersion, kind, specFields: ((.spec // {}) | keys), statusFields: ((.status // {}) | keys)}]}'
```

The shape-only output avoids dumping raw findings. Compare the selected version with
`web/lib/k8sgpt-adapter.ts` and its fixtures, then run adapter tests:

```bash
(cd web && npx vitest run lib/k8sgpt-adapter.test.ts)
```

Missing, denied, empty, down, stale and incompatible Results are distinct states. Reader
compatibility does not approve controller installation or prove successful AI narration.

## H3a remediation seam

`raiseIncidentFromFinding` remains retained code and is not invoked by the Result-read route.
The old recipe that enabled lifecycle → write-back → `remediation_enabled` is **retired**, not an
activation guide. ADR-006 abandoned that remediation wiring; write-back still needs role separation
from frozen remediation. `rca_writeback_enabled` currently hard-requires
`remediation_enabled`; do not satisfy that dependency by enabling the frozen substrate.
Gates and an approval screen do not lift ADR-005.

## Related

[ADR-005](../decisions/005-aws-mutation-autonomy-frozen.md),
[ADR-006](../decisions/006-incident-analysis-only.md), `web/lib/{k8sgpt,k8sgpt-adapter,eks-incluster}.ts`,
`terraform/v2/foundation/{eks,k8sgpt,variables}.tf`.
Upstream schema/chart/RBAC comparison used repository `k8sgpt-ai/k8sgpt-operator`, revision
`d27dd21b1dc4d566b18c120f879e2afa2f0e41a4`, on **2026-09-13**; this is evidence of field/permission
shape, **not an approved chart/image pin**. Recheck the selected release before installation.
