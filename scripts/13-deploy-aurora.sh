#!/usr/bin/env bash
# ADR-030 Phase 1: Deploy Aurora Serverless v2 and apply the application
# state schema. Idempotent — re-running upgrades the schema in place.
#
# Prerequisites:
#   - CDK bootstrapped in the target account/region
#   - AwsopsStack already deployed (this stack depends on its VPC + app SG)
#   - psql (PostgreSQL 15 client) available on the runner
#   - AWS CLI v2 with credentials for the target account
#
# Usage:
#   ./scripts/13-deploy-aurora.sh deploy        # deploys CDK + applies schema
#   ./scripts/13-deploy-aurora.sh schema        # applies schema only (cluster must exist)
#   ./scripts/13-deploy-aurora.sh status        # prints endpoint + schema version
#   ./scripts/13-deploy-aurora.sh dsn           # prints DSN for app .env injection
#
# Environment:
#   AWS_REGION (default: ap-northeast-2)
#   AURORA_STACK_NAME (default: AwsopsDataStack)

set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
STACK="${AURORA_STACK_NAME:-AwsopsDataStack}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CDK_DIR="${REPO_ROOT}/infra-cdk"
SCHEMA_FILE="${CDK_DIR}/data/schema.sql"

err() { echo "[13-deploy-aurora] ERROR: $*" >&2; exit 1; }
log() { echo "[13-deploy-aurora] $*"; }

command -v aws >/dev/null   || err "aws CLI not found"
command -v psql >/dev/null  || err "psql (PostgreSQL client) not found"
command -v jq >/dev/null    || err "jq not found"
[[ -f "${SCHEMA_FILE}" ]]   || err "schema not found: ${SCHEMA_FILE}"

stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --region "${REGION}" \
    --stack-name "${STACK}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null
}

fetch_secret_dsn() {
  local secret_arn="$1"
  local endpoint="$2"
  local port="$3"
  local db="$4"

  local secret_json
  secret_json=$(aws secretsmanager get-secret-value \
    --region "${REGION}" \
    --secret-id "${secret_arn}" \
    --query SecretString --output text)
  local user pw
  user=$(echo "${secret_json}" | jq -r .username)
  pw=$(echo "${secret_json}"   | jq -r .password)
  # URL-encode password (handles special chars in the master password)
  local pw_enc
  pw_enc=$(jq -rn --arg p "${pw}" '$p|@uri')
  echo "postgres://${user}:${pw_enc}@${endpoint}:${port}/${db}?sslmode=require"
}

cmd_deploy() {
  log "Deploying ${STACK} via CDK (enableAurora=true)..."
  cd "${CDK_DIR}"
  npx cdk deploy "${STACK}" \
    --context enableAurora=true \
    --require-approval any-change
  cd - >/dev/null
  cmd_schema
}

cmd_schema() {
  local endpoint port db secret_arn
  endpoint=$(stack_output ClusterEndpoint)
  port=$(stack_output ClusterPort)
  db=$(stack_output DatabaseName)
  secret_arn=$(stack_output MasterSecretArn)

  [[ -n "${endpoint}" ]]   || err "ClusterEndpoint not found in stack outputs"
  [[ -n "${secret_arn}" ]] || err "MasterSecretArn not found in stack outputs"

  local dsn
  dsn=$(fetch_secret_dsn "${secret_arn}" "${endpoint}" "${port:-5432}" "${db:-awsops}")

  log "Applying schema (${SCHEMA_FILE}) to ${endpoint}/${db}..."
  PGPASSWORD_HIDDEN=1 psql "${dsn}" -v ON_ERROR_STOP=1 -f "${SCHEMA_FILE}"

  log "Schema version after apply:"
  psql "${dsn}" -c "SELECT version, applied_at, description FROM schema_migrations ORDER BY version;"
}

cmd_status() {
  local endpoint port db secret_arn
  endpoint=$(stack_output ClusterEndpoint)
  port=$(stack_output ClusterPort)
  db=$(stack_output DatabaseName)
  secret_arn=$(stack_output MasterSecretArn)

  if [[ -z "${endpoint}" ]]; then
    err "Stack ${STACK} not deployed or has no outputs"
  fi

  echo "Stack:         ${STACK}"
  echo "Region:        ${REGION}"
  echo "Endpoint:      ${endpoint}"
  echo "Port:          ${port:-5432}"
  echo "Database:      ${db:-awsops}"
  echo "Secret ARN:    ${secret_arn}"

  local dsn
  dsn=$(fetch_secret_dsn "${secret_arn}" "${endpoint}" "${port:-5432}" "${db:-awsops}")
  echo
  echo "Schema migrations:"
  psql "${dsn}" -c "SELECT version, applied_at, description FROM schema_migrations ORDER BY version;" \
    || log "(could not query schema_migrations — cluster may not be reachable from this host)"
}

cmd_dsn() {
  local endpoint port db secret_arn
  endpoint=$(stack_output ClusterEndpoint)
  port=$(stack_output ClusterPort)
  db=$(stack_output DatabaseName)
  secret_arn=$(stack_output MasterSecretArn)
  [[ -n "${endpoint}" ]]   || err "Stack ${STACK} not deployed"
  fetch_secret_dsn "${secret_arn}" "${endpoint}" "${port:-5432}" "${db:-awsops}"
}

case "${1:-deploy}" in
  deploy) cmd_deploy ;;
  schema) cmd_schema ;;
  status) cmd_status ;;
  dsn)    cmd_dsn    ;;
  *) err "Usage: $0 {deploy|schema|status|dsn}" ;;
esac
