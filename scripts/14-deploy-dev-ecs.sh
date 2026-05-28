#!/usr/bin/env bash
# ADR-030 dev ECS Fargate deploy — build image, push to ECR, roll the service.
#
# Prerequisites:
#   - AwsopsDevEcsStack already provisioned via:
#       cd infra-cdk && npx cdk deploy AwsopsDevEcsStack \
#         -c enableDevEcs=true \
#         -c devDomain=awsops-dev.atomai.click
#   - Docker with buildx (arm64 builder configured)
#   - AWS CLI v2 with credentials for the dev region (default ap-northeast-2)
#
# Usage:
#   ./scripts/14-deploy-dev-ecs.sh build         # build + push the image only
#   ./scripts/14-deploy-dev-ecs.sh roll          # force a new ECS task with :latest
#   ./scripts/14-deploy-dev-ecs.sh full          # build + push + roll (default)
#   ./scripts/14-deploy-dev-ecs.sh status        # print stack outputs + service state
#
# Environment:
#   AWS_REGION (default ap-northeast-2)
#   DEV_STACK  (default AwsopsDevEcsStack)
#   IMAGE_TAG  (default `git rev-parse --short HEAD` plus `latest`)

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
STACK="${DEV_STACK:-AwsopsDevEcsStack}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

err() { echo "[14-deploy-dev-ecs] ERROR: $*" >&2; exit 1; }
log() { echo "[14-deploy-dev-ecs] $*"; }

command -v aws >/dev/null    || err "aws CLI not found"
command -v docker >/dev/null || err "docker not found"

stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --region "${REGION}" \
    --stack-name "${STACK}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null
}

ECR_URI=""
CLUSTER=""
SERVICE=""

load_stack_outputs() {
  ECR_URI=$(stack_output EcrRepoUri)
  CLUSTER=$(stack_output EcsCluster)
  SERVICE=$(stack_output EcsService)
  [[ -n "${ECR_URI}" ]] || err "Stack ${STACK} not deployed or EcrRepoUri output missing"
}

cmd_build() {
  load_stack_outputs
  local sha
  sha=$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo dev)
  local tag="${IMAGE_TAG:-${sha}}"

  log "Logging in to ECR ${ECR_URI%/*}..."
  aws ecr get-login-password --region "${REGION}" \
    | docker login --username AWS --password-stdin "${ECR_URI%/*}"

  log "Building awsops-dev image (arm64) :${tag} and :latest..."
  docker buildx build \
    --platform linux/arm64 \
    --tag "${ECR_URI}:${tag}" \
    --tag "${ECR_URI}:latest" \
    --push \
    "${REPO_ROOT}"

  log "Pushed ${ECR_URI}:${tag} and :latest"
}

cmd_roll() {
  load_stack_outputs
  [[ -n "${CLUSTER}" ]] || err "EcsCluster output missing"
  [[ -n "${SERVICE}" ]] || err "EcsService output missing"

  log "Forcing new deployment on ${CLUSTER}/${SERVICE}..."
  aws ecs update-service \
    --region "${REGION}" \
    --cluster "${CLUSTER}" \
    --service "${SERVICE}" \
    --force-new-deployment \
    --query 'service.{desired:desiredCount,running:runningCount,task:taskDefinition}' \
    --output table
}

cmd_full() {
  cmd_build
  cmd_roll
}

cmd_status() {
  load_stack_outputs
  echo "Stack:       ${STACK}"
  echo "Region:      ${REGION}"
  echo "ECR Repo:    ${ECR_URI}"
  echo "ECS Cluster: ${CLUSTER}"
  echo "ECS Service: ${SERVICE}"
  echo
  echo "Service state:"
  aws ecs describe-services \
    --region "${REGION}" \
    --cluster "${CLUSTER}" \
    --services "${SERVICE}" \
    --query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount,deployments:deployments[].{status:status,rollout:rolloutState,taskDef:taskDefinition}}' \
    --output table
}

case "${1:-full}" in
  build)  cmd_build  ;;
  roll)   cmd_roll   ;;
  full)   cmd_full   ;;
  status) cmd_status ;;
  *) err "Usage: $0 {build|roll|full|status}" ;;
esac
