#!/bin/bash
set -e

EXPECTED_ACCOUNT="180294183052"
EXPECTED_REGION="ap-northeast-2"

echo "=== guard: confirm AWS context before any deletion ==="
# Force the region deterministically for every aws-cli call in this script (this process's env,
# inherited by every subshell/command-substitution below) — never trust ambient
# AWS_REGION/AWS_DEFAULT_REGION/~/.aws/config resolution, since those can differ from what a
# one-time check here observed. Overriding unconditionally (not with :- fallback) means this
# script's calls always target ap-northeast-2 regardless of the calling shell's prior env.
export AWS_REGION="$EXPECTED_REGION"
export AWS_DEFAULT_REGION="$EXPECTED_REGION"
# Deliberately NOT touching AWS_PROFILE/credentials here: whatever profile/credential chain is
# already active in this shell is the one the operator set up to reach the target account, and
# unsetting it would force an implicit fallback to some OTHER source (env keys, [default]
# profile, instance role) instead of pinning to the intended identity. We verify — not replace —
# whatever is currently active, and abort if it doesn't resolve to the expected account below.
ACTUAL_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$ACTUAL_ACCOUNT" ]; then
  echo "ABORT: could not determine caller account (empty response) — refusing to delete anything." >&2
  exit 1
fi
if [ "$ACTUAL_ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  echo "ABORT: wrong AWS account (expected $EXPECTED_ACCOUNT, got $ACTUAL_ACCOUNT) — refusing to delete anything." >&2
  exit 1
fi
echo "account=$ACTUAL_ACCOUNT confirmed; region pinned to $AWS_REGION for the rest of this script"

# Re-run safety: a prior partial run (interrupted, transient error, Ctrl-C) may have already
# deleted some resources. Re-running this script must finish the rest, not die on the first
# "already gone" resource. delete_or_skip distinguishes "already deleted" (idempotent success)
# from a REAL error (permission denied, wrong ARN, etc.) by inspecting the AWS CLI's own error
# text — only a recognized not-found signature is swallowed; anything else re-raises and aborts
# (fail loud), so this never silently treats a genuine failure as success.
# HeadBucket's 404 has no exception name in the CLI error text (unlike delete-bucket's
# NoSuchBucket) — it's just "... HeadBucket operation: Not Found", so "Not Found"/"(404)" must
# be matched explicitly or resource_exists misclassifies a genuinely-absent bucket as a real error.
NOT_FOUND_RE="ResourceNotFoundException|NoSuchBucket|NoSuchEntity|NotFoundException|Not Found|\(404\)|does not exist|could not be found|cannot be found"
delete_or_skip() {
  local desc="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "  deleted: $desc"
    return 0
  fi
  if echo "$out" | grep -qiE "$NOT_FOUND_RE"; then
    echo "  already gone: $desc (treating as success — idempotent re-run)"
    return 0
  fi
  echo "REAL ERROR deleting $desc:" >&2
  echo "$out" >&2
  return 1
}
resource_exists() {
  # $1 = description (for logging only), rest = a "get/describe this one resource" command.
  # Returns 0 (exists) or 1 (confirmed absent). A non-not-found error is a REAL failure (abort).
  local desc="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    return 0
  fi
  if echo "$out" | grep -qiE "$NOT_FOUND_RE"; then
    echo "  already gone: $desc"
    return 1
  fi
  echo "REAL ERROR checking $desc:" >&2
  echo "$out" >&2
  exit 1
}

SKIPPED=()

echo "=== 4.4: deleting 19 orphan v1 Lambda functions (18 *-mcp slices + steampipe-query, idempotent) ==="
LAMBDAS=(
  awsops-terraform-mcp awsops-ecs-mcp awsops-iam-mcp awsops-aws-knowledge
  awsops-cost-mcp awsops-valkey-mcp awsops-network-mcp awsops-rds-mcp
  awsops-iac-mcp awsops-finops-mcp awsops-reachability-analyzer awsops-flow-monitor
  awsops-core-mcp awsops-cloudtrail-mcp awsops-dynamodb-mcp awsops-cloudwatch-mcp
  awsops-eks-mcp awsops-msk-mcp awsops-steampipe-query
)
for fn in "${LAMBDAS[@]}"; do
  delete_or_skip "lambda:$fn" aws lambda delete-function --function-name "$fn"
done

echo "=== 4.4: emptying + deleting v1 deploy bucket (35 objects, ~62MB, v1 diagnosis reports) ==="
if resource_exists "bucket awsops-deploy-180294183052" aws s3api head-bucket --bucket "awsops-deploy-180294183052"; then
  delete_or_skip "objects in awsops-deploy-180294183052" aws s3 rm "s3://awsops-deploy-180294183052" --recursive
  delete_or_skip "bucket awsops-deploy-180294183052" aws s3api delete-bucket --bucket "awsops-deploy-180294183052"
fi

echo "=== 4.5: AgentCore orphans (idempotent) ==="
GATEWAYS=(
  awsops-container-gateway-zacu646nx6 awsops-cost-gateway-fgdtakwe7p
  awsops-data-gateway-9risks8vce awsops-iac-gateway-v3hlm5fivj
  awsops-monitoring-gateway-l4ejgy7qft awsops-network-gateway-tmsin1uggd
  awsops-ops-gateway-njfwx9vxqo awsops-security-gateway-hrzysflvmq
)
for gw in "${GATEWAYS[@]}"; do
  echo "--- gateway $gw ---"
  if ! resource_exists "gateway $gw" aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw"; then
    continue
  fi
  echo "  deleting targets"
  # AWS CLI --output text renders an empty/null query result as the literal string "None"
  # (not empty string) — without filtering that out, an already-empty target list is misread
  # as one target literally named "None" and the delete call below fails with ValidationException.
  TARGET_IDS=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" --query 'items[].targetId' --output text)
  if [ -n "$TARGET_IDS" ] && [ "$TARGET_IDS" != "None" ]; then
    for tgt in $TARGET_IDS; do
      delete_or_skip "target $tgt on $gw" aws bedrock-agentcore-control delete-gateway-target --gateway-identifier "$gw" --target-id "$tgt"
    done
  fi
  attempts=0
  drained=false
  while [ "$attempts" -lt 60 ]; do
    if ! remaining=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" --query 'length(items)' --output text 2>&1); then
      echo "REAL ERROR polling target count for $gw:" >&2
      echo "$remaining" >&2
      exit 1
    fi
    if [ "$remaining" = "0" ]; then
      drained=true
      break
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  if [ "$drained" != true ]; then
    echo "타깃 삭제가 5분 넘게 안 끝남 — 이 게이트웨이는 건너뜀: $gw" >&2
    SKIPPED+=("gateway:$gw (targets never drained — rerun this script later to retry)")
    continue
  fi
  delete_or_skip "gateway $gw" aws bedrock-agentcore-control delete-gateway --gateway-identifier "$gw"
done

echo "--- deleting memory ---"
delete_or_skip "memory awsops_memory-IULWInAGhc" aws bedrock-agentcore-control delete-memory --memory-id awsops_memory-IULWInAGhc
# delete-memory is async (status goes to DELETING, not gone immediately) — a status of DELETING is
# NOT "fully removed", it's still in progress and could stall or fail. Poll until it's actually
# gone (get-memory returns not-found) before treating this as done, same pattern as the gateway
# target drain above.
attempts=0
memory_drained=false
while [ "$attempts" -lt 60 ]; do
  if ! resource_exists "memory awsops_memory-IULWInAGhc" aws bedrock-agentcore-control get-memory --memory-id awsops_memory-IULWInAGhc; then
    memory_drained=true
    break
  fi
  attempts=$((attempts + 1))
  sleep 5
done
if [ "$memory_drained" != true ]; then
  echo "메모리 삭제가 5분 넘게 안 끝남 — rerun this script later to retry" >&2
  SKIPPED+=("memory:awsops_memory-IULWInAGhc (deletion never confirmed drained)")
fi

echo "--- deleting code interpreter ---"
delete_or_skip "code interpreter awsops_code_interpreter-AIOOg6hlCQ" aws bedrock-agentcore-control delete-code-interpreter --code-interpreter-id awsops_code_interpreter-AIOOg6hlCQ

echo ""
echo "=== verification (this is the actual source of truth — re-checks live AWS state, not run-log assumptions) ==="
# DELETE_COMPLETE stacks and DELETING memories are already torn down / tearing down on their own —
# AWS keeps their metadata visible for a while afterward, so excluding those statuses is required
# or a fully-successful teardown reports a false FAIL forever (list-stacks never drops DELETE_COMPLETE
# entries quickly, and delete-memory is async).
REMAINING_STACKS=$(aws cloudformation list-stacks --query "StackSummaries[?contains(StackName,'Awsops') && StackStatus != 'DELETE_COMPLETE']" --output json)
REMAINING_LAMBDAS=$(aws lambda list-functions --query "Functions[?starts_with(FunctionName,'awsops-') && !starts_with(FunctionName,'awsops-v2-')].FunctionName" --output json)
REMAINING_GATEWAYS=$(aws bedrock-agentcore-control list-gateways --query "items[?starts_with(name,'awsops-') && !starts_with(name,'awsops-v2-')]" --output json)
REMAINING_MEMORIES=$(aws bedrock-agentcore-control list-memories --query "memories[?starts_with(id,'awsops_memory') && status != 'DELETING']" --output json)
REMAINING_INTERPRETERS=$(aws bedrock-agentcore-control list-code-interpreters --query "codeInterpreterSummaries[?name=='awsops_code_interpreter']" --output json)
echo "remaining stacks: $REMAINING_STACKS"
echo "remaining orphan lambdas: $REMAINING_LAMBDAS"
echo "remaining v1 gateways: $REMAINING_GATEWAYS"
echo "remaining v1 memories: $REMAINING_MEMORIES"
echo "remaining v1 interpreters: $REMAINING_INTERPRETERS"

BUCKET_GONE=1
resource_exists "bucket awsops-deploy-180294183052 (final check)" aws s3api head-bucket --bucket awsops-deploy-180294183052 && BUCKET_GONE=0 || true

# ALB/SQS are NOT deleted by this script (docs/runbooks/v1-decommission.md §4.5 requires a manual
# CFN-stack-membership check first — if AwsopsStack owns them, 4.3's stack delete already removed
# them; if not, they need the manual listener→ALB→target-group teardown order the runbook spells
# out, which this script deliberately does not automate). We only verify here, but we DO fail the
# run on their continued presence — the ALB especially is billed (awsops-alb, internet-facing,
# targeting the stopped v1 EC2) — so this can't be a silent skip the way a first draft of this
# script left it.
ALB_STATUS=$(aws elbv2 describe-load-balancers --names awsops-alb 2>&1 | tail -1)
SQS1_STATUS=$(aws sqs get-queue-url --queue-name awsops-alert-queue 2>&1 | tail -1)
SQS2_STATUS=$(aws sqs get-queue-url --queue-name awsops-alert-dlq 2>&1 | tail -1)
echo "ALB: $ALB_STATUS"
echo "SQS main: $SQS1_STATUS"
echo "SQS dlq: $SQS2_STATUS"
echo "bucket gone: $([ "$BUCKET_GONE" = "1" ] && echo yes || echo NO)"

ALB_GONE=1
echo "$ALB_STATUS" | grep -qiE "$NOT_FOUND_RE|LoadBalancerNotFound" || ALB_GONE=0
SQS_GONE=1
echo "$SQS1_STATUS" | grep -qiE "$NOT_FOUND_RE|NonExistentQueue|QueueDoesNotExist" || SQS_GONE=0
echo "$SQS2_STATUS" | grep -qiE "$NOT_FOUND_RE|NonExistentQueue|QueueDoesNotExist" || SQS_GONE=0

V2_HEALTH=$(curl -sS -o /dev/null -w "%{http_code}" https://awsops-v2.atomai.click/api/health)
echo "v2 health: $V2_HEALTH"

FAIL=0
[ "$REMAINING_STACKS" != "[]" ] && { echo "FAIL: CFN stack still present"; FAIL=1; }
[ "$REMAINING_LAMBDAS" != "[]" ] && { echo "FAIL: orphan lambdas still present: $REMAINING_LAMBDAS"; FAIL=1; }
[ "$REMAINING_GATEWAYS" != "[]" ] && { echo "FAIL: v1 gateways still present"; FAIL=1; }
[ "$REMAINING_MEMORIES" != "[]" ] && { echo "FAIL: v1 memory still present"; FAIL=1; }
[ "$REMAINING_INTERPRETERS" != "[]" ] && { echo "FAIL: v1 code interpreter still present"; FAIL=1; }
[ "$BUCKET_GONE" != "1" ] && { echo "FAIL: v1 deploy bucket still present"; FAIL=1; }
[ "$ALB_GONE" != "1" ] && { echo "FAIL: awsops-alb still present (billed!) — not deleted by this script, see docs/runbooks/v1-decommission.md §4.5"; FAIL=1; }
[ "$SQS_GONE" != "1" ] && { echo "FAIL: awsops-alert-queue/awsops-alert-dlq still present — not deleted by this script, see docs/runbooks/v1-decommission.md §4.5"; FAIL=1; }
[ "$V2_HEALTH" != "200" ] && { echo "FAIL: v2 health check did not return 200 (got $V2_HEALTH)"; FAIL=1; }
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "SKIPPED during this run:"
  printf '  - %s\n' "${SKIPPED[@]}"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "=== INCOMPLETE — see FAIL/SKIPPED lines above. This script is safe to re-run as-is (idempotent) to retry only what's left. ==="
  exit 1
fi

echo ""
echo "=== ALL CLEAR — Phase 4.4/4.5 fully complete (verified against live AWS state), v2 confirmed healthy ==="
