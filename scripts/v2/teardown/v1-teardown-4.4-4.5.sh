#!/bin/bash
set -eu

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

# PRE-FLIGHT: this script implements Phase 4.4/4.5 only — it assumes Phase 4.3 (CFN stack deletion)
# already completed. If an Awsops stack is still around, deleting its member resources out from
# under CloudFormation is the wrong order, so abort.
PRE_STACKS=$(aws cloudformation list-stacks --query "StackSummaries[?contains(StackName,'Awsops') && StackStatus != 'DELETE_COMPLETE']" --output json)
if [ "$PRE_STACKS" != "[]" ]; then
  echo "ABORT: an Awsops CloudFormation stack is still present — Phase 4.3 (stack deletion) has not completed. This script assumes Phase 4.3 already ran. Stacks: $PRE_STACKS" >&2
  exit 1
fi

# Human-confirmation gate (the runbook's mandatory confirmation step): bare execution is a DRY RUN
# that resolves live state and prints what WOULD be deleted. Real deletion requires CONFIRM=yes.
# Every aws call below is guarded by `if`, so a read error can never trip set -e.
if [ "${CONFIRM:-}" != "yes" ]; then
  echo "=== DRY RUN (CONFIRM!=yes) — resolving current state, deleting nothing ==="
  echo "--- Lambda functions ---"
  for fn in awsops-terraform-mcp awsops-ecs-mcp awsops-iam-mcp awsops-aws-knowledge \
            awsops-cost-mcp awsops-valkey-mcp awsops-network-mcp awsops-rds-mcp \
            awsops-iac-mcp awsops-finops-mcp awsops-reachability-analyzer awsops-flow-monitor \
            awsops-core-mcp awsops-cloudtrail-mcp awsops-dynamodb-mcp awsops-cloudwatch-mcp \
            awsops-eks-mcp awsops-msk-mcp awsops-steampipe-query; do
    if out=$(aws lambda get-function --function-name "$fn" --query 'Configuration.FunctionName' --output text 2>&1); then
      echo "  would delete: $fn (exists)"
    else
      echo "  already gone: $fn"
    fi
  done
  echo "--- deploy bucket ---"
  if cnt=$(aws s3api list-objects-v2 --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" --query 'KeyCount' --output text 2>&1); then
    echo "  would empty + delete: awsops-deploy-180294183052 (approx $cnt objects — 1000 means 1000+ / paginated count)"
  else
    echo "  already gone or inaccessible: awsops-deploy-180294183052 ($cnt)"
  fi
  echo "--- AgentCore gateways ---"
  for gw in awsops-container-gateway-zacu646nx6 awsops-cost-gateway-fgdtakwe7p \
            awsops-data-gateway-9risks8vce awsops-iac-gateway-v3hlm5fivj \
            awsops-monitoring-gateway-l4ejgy7qft awsops-network-gateway-tmsin1uggd \
            awsops-ops-gateway-njfwx9vxqo awsops-security-gateway-hrzysflvmq; do
    if gw_info=$(aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw" --query '{name:name,status:status}' --output json 2>&1); then
      tgt_count=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" --query 'length(items || [])' --output text 2>&1)
      echo "  would delete: $gw ($gw_info, $tgt_count target(s))"
    else
      echo "  already gone: $gw"
    fi
  done
  echo "--- memory ---"
  if mem_info=$(aws bedrock-agentcore-control get-memory --memory-id awsops_memory-IULWInAGhc --query '{id:id,status:status}' --output json 2>&1); then
    echo "  would delete: awsops_memory-IULWInAGhc ($mem_info)"
  else
    echo "  already gone: awsops_memory-IULWInAGhc"
  fi
  echo "--- code interpreter ---"
  if ci_info=$(aws bedrock-agentcore-control get-code-interpreter --code-interpreter-id awsops_code_interpreter-AIOOg6hlCQ --query 'status' --output text 2>&1); then
    echo "  would delete: awsops_code_interpreter-AIOOg6hlCQ (status=$ci_info)"
  else
    echo "  already gone: awsops_code_interpreter-AIOOg6hlCQ"
  fi
  echo ""
  echo "=== DRY-RUN complete — nothing deleted. Re-run with CONFIRM=yes to execute. ==="
  exit 0
fi

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
DELETE_IN_PROGRESS_RE="ConflictException|ResourceInUseException|already.*(deleting|being deleted)|DeleteInProgress"
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
  if echo "$out" | grep -qiE "$DELETE_IN_PROGRESS_RE"; then
    echo "  deletion already in progress: $desc (treating as success — idempotent re-run)"
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
if resource_exists "bucket awsops-deploy-180294183052" aws s3api head-bucket --bucket "awsops-deploy-180294183052" --expected-bucket-owner "$EXPECTED_ACCOUNT"; then
  # `aws s3 rm --recursive` cannot delete noncurrent versions/delete markers (so a versioned bucket
  # never actually empties and delete-bucket then fails) and it accepts no --expected-bucket-owner.
  # Drain via s3api list-object-versions + delete-objects instead, bounded so it can't spin forever.
  emptied=0
  for i in $(seq 1 100); do
    page=$(aws s3api list-object-versions --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" --max-items 1000 --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][]}' --output json)
    count=$(echo "$page" | jq '.Objects | length')
    if [ "$count" = "0" ] || [ -z "$count" ]; then
      emptied=1
      break
    fi
    delete_or_skip "batch of $count object version(s) in awsops-deploy-180294183052" \
      aws s3api delete-objects --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" \
      --delete "$(echo "$page" | jq -c '. + {Quiet:true}')"
  done
  if [ "$emptied" != "1" ]; then
    echo "REAL ERROR: bucket awsops-deploy-180294183052 did not empty after 100 batches" >&2
    exit 1
  fi
  delete_or_skip "bucket awsops-deploy-180294183052" aws s3api delete-bucket --bucket "awsops-deploy-180294183052" --expected-bucket-owner "$EXPECTED_ACCOUNT"
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
  # Belt-and-braces: the hardcoded IDs above are v1 gateways, but re-resolve the name before any
  # destructive call and refuse anything that isn't a v1 awsops-* gateway.
  gw_name=$(aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw" --query name --output text)
  case "$gw_name" in
    awsops-v2-*)
      echo "REFUSING to delete gateway $gw — resolved name '$gw_name' looks like a v2 gateway" >&2
      SKIPPED+=("gateway:$gw (name assertion failed: $gw_name)")
      continue
      ;;
    awsops-*) ;;
    *)
      echo "REFUSING to delete gateway $gw — resolved name '$gw_name' does not start with awsops-" >&2
      SKIPPED+=("gateway:$gw (name assertion failed: $gw_name)")
      continue
      ;;
  esac
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
    if ! remaining=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" --query 'length(items || [])' --output text 2>&1); then
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
REMAINING_GATEWAYS=$(aws bedrock-agentcore-control list-gateways --query "items[?starts_with(name,'awsops-') && !starts_with(name,'awsops-v2-') && status != 'DELETING']" --output json)
REMAINING_MEMORIES=$(aws bedrock-agentcore-control list-memories --query "memories[?starts_with(id,'awsops_memory') && status != 'DELETING']" --output json)
REMAINING_INTERPRETERS=$(aws bedrock-agentcore-control list-code-interpreters --query "codeInterpreterSummaries[?name=='awsops_code_interpreter' && status != 'DELETING']" --output json)
echo "remaining stacks: $REMAINING_STACKS"
echo "remaining orphan lambdas: $REMAINING_LAMBDAS"
echo "remaining v1 gateways: $REMAINING_GATEWAYS"
echo "remaining v1 memories: $REMAINING_MEMORIES"
echo "remaining v1 interpreters: $REMAINING_INTERPRETERS"

# Three-state (present / gone / indeterminate) instead of routing through resource_exists — a 403 or
# throttle there hard-exits and kills the whole verification block instead of reporting a FAIL.
if BUCKET_OUT=$(aws s3api head-bucket --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" 2>&1); then
  BUCKET_STATE=present
elif echo "$BUCKET_OUT" | grep -qiE "$NOT_FOUND_RE"; then
  BUCKET_STATE=gone
else
  BUCKET_STATE=indeterminate
fi

# ALB/SQS are NOT deleted by this script (docs/runbooks/v1-decommission.md §4.5 requires a manual
# CFN-stack-membership check first — if AwsopsStack owns them, 4.3's stack delete already removed
# them; if not, they need the manual listener→ALB→target-group teardown order the runbook spells
# out, which this script deliberately does not automate). We only verify here, but we DO fail the
# run on their continued presence — the ALB especially is billed (awsops-alb, internet-facing,
# targeting the stopped v1 EC2) — so this can't be a silent skip the way a first draft of this
# script left it.
# Same three-state treatment: an AccessDenied/throttle is "indeterminate", never silently folded
# into "confirmed present" or "confirmed gone".
if ALB_OUT=$(aws elbv2 describe-load-balancers --names awsops-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>&1); then
  ALB_STATE=present
elif echo "$ALB_OUT" | grep -qiE "$NOT_FOUND_RE|LoadBalancerNotFound"; then
  ALB_STATE=gone
else
  ALB_STATE=indeterminate
fi
if SQS1_OUT=$(aws sqs get-queue-url --queue-name awsops-alert-queue --query QueueUrl --output text 2>&1); then
  SQS1_STATE=present
elif echo "$SQS1_OUT" | grep -qiE "$NOT_FOUND_RE|NonExistentQueue|QueueDoesNotExist"; then
  SQS1_STATE=gone
else
  SQS1_STATE=indeterminate
fi
if SQS2_OUT=$(aws sqs get-queue-url --queue-name awsops-alert-dlq --query QueueUrl --output text 2>&1); then
  SQS2_STATE=present
elif echo "$SQS2_OUT" | grep -qiE "$NOT_FOUND_RE|NonExistentQueue|QueueDoesNotExist"; then
  SQS2_STATE=gone
else
  SQS2_STATE=indeterminate
fi
echo "ALB: $ALB_STATE ($ALB_OUT)"
echo "SQS main: $SQS1_STATE ($SQS1_OUT)"
echo "SQS dlq: $SQS2_STATE ($SQS2_OUT)"
echo "bucket state: $BUCKET_STATE"

V2_HEALTH=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://awsops-v2.atomai.click/api/health 2>/dev/null) || V2_HEALTH=000
echo "v2 health: $V2_HEALTH"

FAIL=0
[ "$REMAINING_STACKS" != "[]" ] && { echo "FAIL: CFN stack still present"; FAIL=1; }
[ "$REMAINING_LAMBDAS" != "[]" ] && { echo "FAIL: orphan lambdas still present: $REMAINING_LAMBDAS"; FAIL=1; }
[ "$REMAINING_GATEWAYS" != "[]" ] && { echo "FAIL: v1 gateways still present"; FAIL=1; }
[ "$REMAINING_MEMORIES" != "[]" ] && { echo "FAIL: v1 memory still present"; FAIL=1; }
[ "$REMAINING_INTERPRETERS" != "[]" ] && { echo "FAIL: v1 code interpreter still present"; FAIL=1; }
[ "$BUCKET_STATE" = "present" ] && { echo "FAIL: v1 deploy bucket still present"; FAIL=1; }
[ "$BUCKET_STATE" = "indeterminate" ] && { echo "FAIL: could not verify deploy bucket (indeterminate): $BUCKET_OUT"; FAIL=1; }
[ "$ALB_STATE" = "present" ] && { echo "FAIL: awsops-alb still present (billed!) — not deleted by this script, see docs/runbooks/v1-decommission.md §4.5"; FAIL=1; }
[ "$ALB_STATE" = "indeterminate" ] && { echo "FAIL: could not verify awsops-alb (indeterminate — presence NOT established): $ALB_OUT"; FAIL=1; }
[ "$SQS1_STATE" = "present" ] || [ "$SQS2_STATE" = "present" ] && { echo "FAIL: awsops-alert-queue/awsops-alert-dlq still present — not deleted by this script, see docs/runbooks/v1-decommission.md §4.5"; FAIL=1; }
[ "$SQS1_STATE" = "indeterminate" ] || [ "$SQS2_STATE" = "indeterminate" ] && { echo "FAIL: could not verify awsops-alert-queue/awsops-alert-dlq (indeterminate — presence NOT established)"; FAIL=1; }
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
