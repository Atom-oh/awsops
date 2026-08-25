#!/usr/bin/env bash
# Grant the AWSops worker Fargate task role a minimal EKS Access Entry so the Network Path
# Check's resolve_live_identity() can GET a single named Pod or Node object
# (scripts/v2/workers/network_path.py) — nothing more.
#
# Run this as an operator who holds cluster permissions (eks:CreateAccessEntry +
# eks:UpdateAccessEntry) AND cluster-admin (or equivalent RBAC-write) k8s access to apply the
# ClusterRole/ClusterRoleBinding below. AWSops deliberately does NOT create this access entry in
# terraform — granting a principal k8s access is the cluster owner's call (read-only stance; the
# apply principal may not own third-party clusters). Re-running is safe (already-exists is
# tolerated).
#
# Usage:
#   scripts/v2/eks/register-network-path-access.sh <cluster-name> [<cluster-name> ...]
#   ROLE_ARN=arn:aws:iam::...:role/awsops-v2-worker-task scripts/v2/eks/register-network-path-access.sh <cluster>
#
# The worker task role ARN is read from `terraform output -raw worker_task_role_arn` unless
# ROLE_ARN is set.
#
# CI-review MAJOR fix (round 19): this used to associate the AWS-managed `AmazonEKSAdminViewPolicy`
# (cluster scope) on the access entry, the SAME policy eks.tf binds for the web task role's OWN
# manual-registration Access Entry. That was the wrong precedent to reuse here: this feature's
# resolve_live_identity() only ever GETs ONE named Node and ONE named Pod, but AdminView grants
# cluster-wide LIST/GET/WATCH on every cluster-scoped resource AND every Secret in every namespace
# — to the SAME shared worker task role every other job type runs under. The sibling script,
# register-istio-access.sh, explicitly documents why NOT to do this ("do NOT widen to AdminView —
# that would grant cluster-wide Secret read to an automated agent"); this script was the one place
# that violated its own repo's documented convention.
#
# Fix: bind the principal to a Kubernetes GROUP (`network-path-reader`) via `--kubernetes-groups`
# instead of an AWS-managed access policy, and authorize that group with a minimal ClusterRole
# granting ONLY `get` on `nodes` and `pods` — no Secret access, no LIST/WATCH, no other resource
# kind. See network-path-reader-rbac.yaml (applied separately via kubectl, since Access Entries
# alone establish the IAM-principal -> k8s-group mapping; RBAC authorization is still needed).
set -euo pipefail

CHDIR="$(cd "$(dirname "$0")/../../../terraform/v2/foundation" && pwd)"
K8S_GROUP="network-path-reader"
RBAC_MANIFEST="$(cd "$(dirname "$0")" && pwd)/network-path-reader-rbac.yaml"

ROLE_ARN="${ROLE_ARN:-$(terraform -chdir="$CHDIR" output -raw worker_task_role_arn 2>/dev/null || true)}"
if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "null" ]; then
  echo "ERROR: worker_task_role_arn unavailable (is workers_enabled + apply done?). Pass ROLE_ARN=..." >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <cluster-name> [<cluster-name> ...]" >&2
  exit 1
fi

echo "Principal: $ROLE_ARN"
echo "Kubernetes group: $K8S_GROUP (authorized via $RBAC_MANIFEST — apply that manifest separately"
echo "with kubectl once per cluster; this script only manages the IAM-side Access Entry)"
for C in "$@"; do
  echo "== ${C}: register minimal Node/Pod GET access =="
  # Only treat ResourceInUseException (already registered) as benign — surface real errors
  # (e.g. AccessDenied) instead of masking them as "already exists".
  if err=$(aws eks create-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" \
      --type STANDARD --kubernetes-groups "$K8S_GROUP" 2>&1); then
    echo "  access entry created (kubernetes-groups=$K8S_GROUP)"
  elif printf '%s' "$err" | grep -q "ResourceInUseException"; then
    # Entry already exists (e.g. from a prior run, or created without the group) — make the
    # kubernetes-groups binding converge via an explicit update rather than assuming it's already
    # correct, so this script stays idempotent regardless of how the entry got there.
    if uerr=$(aws eks update-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" \
        --kubernetes-groups "$K8S_GROUP" 2>&1); then
      echo "  access entry already existed; kubernetes-groups converged to $K8S_GROUP"
    else
      echo "  ERROR updating kubernetes-groups on ${C}: $uerr" >&2
      exit 1
    fi
  else
    echo "  ERROR creating access entry on ${C}: $err" >&2
    exit 1
  fi
done
echo "Done. Now apply the RBAC manifest once per cluster (requires cluster-admin k8s access):"
echo "  kubectl apply -f $RBAC_MANIFEST"
echo "Network Path checks sourced from a pod/node on: $* can then resolve live identity."
echo "To revoke: aws eks delete-access-entry --cluster-name <c> --principal-arn $ROLE_ARN"
