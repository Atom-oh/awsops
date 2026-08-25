#!/usr/bin/env bash
# Grant the AWSops worker Fargate task role a cluster-scoped EKS Access Entry so the Network Path
# Check's resolve_live_identity() can GET Pod/Node objects (scripts/v2/workers/network_path.py).
#
# Run this as an operator WHO HOLDS cluster permissions (eks:CreateAccessEntry +
# eks:AssociateAccessPolicy). AWSops deliberately does NOT create this access entry in terraform —
# granting a principal k8s access is the cluster owner's call (read-only stance; the apply principal
# may not own third-party clusters). Re-running is safe (already-exists is tolerated).
#
# Usage:
#   scripts/v2/eks/register-network-path-access.sh <cluster-name> [<cluster-name> ...]
#   ROLE_ARN=arn:aws:iam::...:role/awsops-v2-worker-task scripts/v2/eks/register-network-path-access.sh <cluster>
#
# The worker task role ARN is read from `terraform output -raw worker_task_role_arn` unless
# ROLE_ARN is set.
#
# POLICY = AmazonEKSAdminViewPolicy (cluster scope) — NOT AmazonEKSViewPolicy. This is the SAME
# policy eks.tf binds for the web task role's own manual-registration Access Entry, and for the
# SAME reason: `resolve_live_identity()` GETs `/api/v1/nodes/{name}`, a CLUSTER-SCOPED resource.
# AmazonEKSViewPolicy mirrors the k8s `view` ClusterRole, which has NO cluster-scoped resources at
# all (listing/getting nodes 403s under it) — it is the wrong precedent for this feature, even
# though it is the right one for the istio-read MCP's namespaced-only CRD reads
# (register-istio-access.sh). Do not swap this back to View: doing so silently breaks every
# pod/node-sourced Network Path check with a bounded (but confusing) AccessDenied.
set -euo pipefail

CHDIR="$(cd "$(dirname "$0")/../../../terraform/v2/foundation" && pwd)"
POLICY="arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy"

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
for C in "$@"; do
  echo "== ${C}: register read-only Node/Pod access =="
  # Only treat ResourceInUseException (already registered) as benign — surface real errors
  # (e.g. AccessDenied) instead of masking them as "already exists".
  if err=$(aws eks create-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" --type STANDARD 2>&1); then
    echo "  access entry created"
  elif printf '%s' "$err" | grep -q "ResourceInUseException"; then
    echo "  access entry already exists (ok)"
  else
    echo "  ERROR creating access entry on ${C}: $err" >&2
    exit 1
  fi
  # associate-access-policy is an upsert (idempotent), but guard it so a failure here surfaces clearly
  # instead of leaving an access-entry-without-policy partial state under `set -e`.
  if aerr=$(aws eks associate-access-policy --cluster-name "$C" --principal-arn "$ROLE_ARN" \
      --policy-arn "$POLICY" --access-scope type=cluster 2>&1); then
    echo "  AdminView policy associated (cluster scope — grants the cluster-scoped Node/Pod GET"
    echo "  resolve_live_identity() needs; also grants Secret read, unlike istio-read's View policy)"
  else
    echo "  ERROR associating AdminView policy on ${C} (entry exists but policy NOT attached): $aerr" >&2
    exit 1
  fi
done
echo "Done. Network Path checks sourced from a pod/node on: $* can now resolve live identity."
echo "To revoke: aws eks delete-access-entry --cluster-name <c> --principal-arn $ROLE_ARN"
