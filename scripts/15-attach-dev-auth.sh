#!/usr/bin/env bash
# ADR-030 dev ECS — thin wrapper that runs scripts/08-setup-cloudfront-auth.sh
# against AwsopsDevEcsStack instead of the prod AwsopsStack. Use this once
# the dev CloudFront has been provisioned but BEFORE sharing the dev URL
# externally (the dev distribution is publicly reachable until Lambda@Edge
# auth attaches).
#
# Usage:
#   ./scripts/15-attach-dev-auth.sh
#   AWS_DEFAULT_REGION=ap-northeast-2 ./scripts/15-attach-dev-auth.sh
#
# Environment:
#   DEV_STACK (default AwsopsDevEcsStack)
#   AWS_DEFAULT_REGION (default ap-northeast-2)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_STACK="${DEV_STACK:-AwsopsDevEcsStack}"

# Pin the auto-detect to the dev stack and delegate to the existing script
# so any future improvements there benefit dev for free.
export CF_STACK_NAME="${DEV_STACK}"

echo "[15-attach-dev-auth] Attaching Lambda@Edge to ${CF_STACK_NAME} CloudFront..."
exec "${SCRIPT_DIR}/08-setup-cloudfront-auth.sh"
