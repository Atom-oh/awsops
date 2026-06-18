#!/usr/bin/env bash
# Grant the AWSops agent Lambda role READ access (AmazonEKSAdminViewPolicy, cluster scope) on EKS
# cluster(s) so the istio-read MCP can LIST Istio CRDs via the Kubernetes API.
#
# Run this as an operator WHO HOLDS cluster permissions (eks:CreateAccessEntry +
# eks:AssociateAccessPolicy). AWSops deliberately does NOT create this access entry in terraform —
# granting a principal k8s access is the cluster owner's call (read-only stance; the apply principal
# may not own third-party clusters). Idempotent: re-running is safe.
#
# Usage:
#   scripts/v2/eks/register-istio-access.sh <cluster-name> [<cluster-name> ...]
#   ROLE_ARN=arn:aws:iam::...:role/awsops-v2-agent-lambda scripts/v2/eks/register-istio-access.sh <cluster>
#
# The agent Lambda role ARN is read from `terraform output -raw agent_lambda_role_arn` unless ROLE_ARN
# is set. (AdminView, not View: listing cluster-scoped CRDs needs AdminViewPolicy; istio-read only
# GET/LISTs Istio CRDs + namespaces.)
set -euo pipefail

CHDIR="$(cd "$(dirname "$0")/../../../terraform/v2/foundation" && pwd)"
POLICY="arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy"

ROLE_ARN="${ROLE_ARN:-$(terraform -chdir="$CHDIR" output -raw agent_lambda_role_arn 2>/dev/null || true)}"
if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "null" ]; then
  echo "ERROR: agent_lambda_role_arn unavailable (is agentcore_enabled + apply done?). Pass ROLE_ARN=..." >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <cluster-name> [<cluster-name> ...]" >&2
  exit 1
fi

echo "Principal: $ROLE_ARN"
for C in "$@"; do
  echo "== ${C}: register read-only access =="
  if aws eks create-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" --type STANDARD >/dev/null 2>&1; then
    echo "  access entry created"
  else
    echo "  access entry already exists (ok)"
  fi
  aws eks associate-access-policy --cluster-name "$C" --principal-arn "$ROLE_ARN" \
    --policy-arn "$POLICY" --access-scope type=cluster >/dev/null
  echo "  AdminView policy associated (cluster scope)"
done
echo "Done. istio-read can now LIST Istio CRDs on: $*"
echo "To revoke: aws eks delete-access-entry --cluster-name <c> --principal-arn $ROLE_ARN"
