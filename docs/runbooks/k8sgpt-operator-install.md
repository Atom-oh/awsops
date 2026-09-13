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

## Action — deterministic-only operator install

Use the selected release's real values and rendered manifests. The former
`--set k8sgpt.deployAnonymized=true` recipe was not a verified chart contract. Inspect the chart
and explicitly disable AI explanation and automatic remediation in the CR. AWSops provides its own
separate narration; no K8sGPT AI credential is needed for deterministic analysis.

```bash
set -euo pipefail
: "${PINNED_OPERATOR_VERSION:?Set the reviewed compatible Helm chart version}"
helm repo add k8sgpt https://charts.k8sgpt.ai/
helm repo update k8sgpt
helm show chart k8sgpt/k8sgpt-operator --version "$PINNED_OPERATOR_VERSION"
helm show values k8sgpt/k8sgpt-operator --version "$PINNED_OPERATOR_VERSION" \
  > /tmp/awsops-k8sgpt-values.yaml
helm template k8sgpt-operator k8sgpt/k8sgpt-operator \
  --namespace k8sgpt-operator-system --version "$PINNED_OPERATOR_VERSION" \
  > /tmp/awsops-k8sgpt-rendered.yaml
```

Review permissions/default CRs before the separately authorized installation:

```bash
: "${PINNED_OPERATOR_VERSION:?Set the reviewed compatible Helm chart version}"
helm upgrade --install k8sgpt-operator k8sgpt/k8sgpt-operator \
  --namespace k8sgpt-operator-system --create-namespace --version "$PINNED_OPERATOR_VERSION"
kubectl explain k8sgpt.spec.ai --api-version=core.k8sgpt.ai/v1alpha1
```

Example CR for a release that supports these fields; replace the image version and verify the selected
CRD before applying. `ai.enabled=false` is explicit; merely omitting an explanation CLI flag is not proof
of controller behavior. Keep automatic remediation disabled and configure no external sink or AI secret.

```yaml
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata:
  name: k8sgpt-deterministic
  namespace: k8sgpt-operator-system
spec:
  version: "<REVIEWED_COMPATIBLE_IMAGE_VERSION>"
  noCache: false
  ai:
    enabled: false
    anonymized: true
    autoRemediation:
      enabled: false
```

The operator/controller must be able to manage its own reconciliation objects and publish Results;
a claim that the entire operator has only GET/list/watch permissions is inaccurate. Review the
rendered RBAC to distinguish controller bookkeeping from analyzed-workload permissions. Do not grant
workload mutation/auto-remediation for this integration. If the selected release cannot meet that
boundary, it is not a compatible deployment for this runbook.

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

## Validation the operator runs

Verify deterministic Results, compatible schema, and reads using the AWSops principal, not only an
operator's cluster-admin session. Run adapter tests after a version change:

```bash
(cd web && npx vitest run lib/k8sgpt-adapter.test.ts)
```

Confirm no AI backend credential, fix mode, or automatic remediation is enabled. Empty/down/stale
operator results should degrade honestly; a controller install alone does not establish successful narration.

## H3a remediation seam

`raiseIncidentFromFinding` remains retained code and is not invoked by the Result-read route.
The old recipe that enabled lifecycle → write-back → `remediation_enabled` is **retired**, not an
activation guide. ADR-006 abandoned that remediation wiring; write-back still needs role separation
from frozen remediation. Gates and an approval screen do not lift ADR-005.

## Related

[ADR-005](../decisions/005-aws-mutation-autonomy-frozen.md),
[ADR-006](../decisions/006-incident-analysis-only.md), `web/lib/{k8sgpt,k8sgpt-adapter,eks-incluster}.ts`,
`terraform/v2/foundation/{eks,k8sgpt,variables}.tf`.
Upstream schema/chart/RBAC comparison used repository `k8sgpt-ai/k8sgpt-operator`, revision
`d27dd21b1dc4d566b18c120f879e2afa2f0e41a4`, on **2026-09-13**; this is evidence of field/permission
shape, **not an approved chart/image pin**. Recheck the selected release before installation.
