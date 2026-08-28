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

# `jq` is a hard dependency (bucket-drain page parsing, step-(b) inventory diff below) but was
# never checked for — a missing binary would abort mid-run with a bash "command not found"
# instead of this script's own fail-loud-before-any-mutation posture.
if ! command -v jq >/dev/null 2>&1; then
  echo "ABORT: jq is required (bucket-drain and inventory-diff JSON parsing) but is not installed." >&2
  exit 1
fi

# Moved up (was declared only in the CONFIRM-path section below) so the DRY-RUN branch's existence
# checks can also use it — see the CI-review MAJOR fix on the DRY-RUN branch's own comment for why.
# HeadBucket's 404 has no exception name in the CLI error text (unlike delete-bucket's
# NoSuchBucket) — it's just "... HeadBucket operation: Not Found", so "Not Found"/"(404)" must be
# matched explicitly or a not-found response gets misclassified as a real/indeterminate error.
NOT_FOUND_RE="ResourceNotFoundException|NoSuchBucket|NoSuchEntity|NotFoundException|Not Found|\(404\)|does not exist|could not be found|cannot be found"

# PRE-FLIGHT: this script implements Phase 4.4/4.5 only — it assumes Phase 4.3 (CFN stack deletion)
# already completed. If an Awsops stack is still around, deleting its member resources out from
# under CloudFormation is the wrong order, so abort.
PRE_STACKS=$(aws cloudformation list-stacks --query "StackSummaries[?contains(StackName,'Awsops') && StackStatus != 'DELETE_COMPLETE']" --output json)
if [ "$PRE_STACKS" != "[]" ]; then
  echo "ABORT: an Awsops CloudFormation stack is still present — Phase 4.3 (stack deletion) has not completed. This script assumes Phase 4.3 already ran. Stacks: $PRE_STACKS" >&2
  exit 1
fi

# The two lists this script deletes from — declared HERE (not duplicated separately inside the
# DRY-RUN branch below) so the dry-run preview and the real deletion path can never drift apart.
#
# CI-review fix: the ORIGINAL 19-name list was itself stale relative to this repo's own
# `agent/lambda/create_targets.py`, which additionally registers `awsops-istio-mcp` (backed by
# the pre-v2 `aws_istio_mcp.py` — v2's read-only rewrite is `istio_read_mcp.py`, deployed under
# the DIFFERENT name `awsops-v2-istio-read` per `terraform/v2/foundation/ai.tf`) and
# `awsops-datasource-diag-mcp` (backed by `datasource_diag_mcp.py`, which v2 does not deploy at
# all — `network_path_adapters.py`'s own docstring explicitly disclaims calling it). Neither name
# collides with anything v2 owns; both are confirmed v1-only orphans. 21 total.
LAMBDAS=(
  awsops-terraform-mcp awsops-ecs-mcp awsops-iam-mcp awsops-aws-knowledge
  awsops-cost-mcp awsops-valkey-mcp awsops-network-mcp awsops-rds-mcp
  awsops-iac-mcp awsops-finops-mcp awsops-reachability-analyzer awsops-flow-monitor
  awsops-core-mcp awsops-cloudtrail-mcp awsops-dynamodb-mcp awsops-cloudwatch-mcp
  awsops-eks-mcp awsops-msk-mcp awsops-steampipe-query
  awsops-istio-mcp awsops-datasource-diag-mcp
)
GATEWAYS=(
  awsops-container-gateway-zacu646nx6 awsops-cost-gateway-fgdtakwe7p
  awsops-data-gateway-9risks8vce awsops-iac-gateway-v3hlm5fivj
  awsops-monitoring-gateway-l4ejgy7qft awsops-network-gateway-tmsin1uggd
  awsops-ops-gateway-njfwx9vxqo awsops-security-gateway-hrzysflvmq
)

# CI-review MAJOR fix: the runbook's mandatory step (b) — comparing live AWS inventory against
# the investigation-time list BEFORE any deletion — was replaced by trusting the hardcoded
# LAMBDAS/GATEWAYS arrays (and the single hardcoded memory/interpreter id below) outright, with
# nothing checking they still match live state. This runs the SAME live prefix queries the
# verification block (near the bottom of this script) uses, in BOTH the dry run and the real
# (AWSOPS_V1_TEARDOWN_CONFIRM) path, and reports any live v1 resource this script's own lists
# don't know about. (The missing istio-mcp/datasource-diag-mcp Lambdas were actually found by a
# static cross-check against this repo's own agent/lambda/create_targets.py, NOT by running this
# live diff against real AWS state — this check is the general defense-in-depth version of that
# same fix, for anything a future source-code cross-check wouldn't catch.) A live resource outside
# these lists would otherwise never be flagged by name, yet the verification block's live prefix
# query would go on reporting it forever — a permanently un-clearable FAIL with nothing pointing
# at the real cause. Originally this only covered Lambdas/gateways; extended to memory/code
# interpreter (each expected to have exactly ONE live v1 resource, or zero if already deleted) so
# the pre-flight check and the verification block assert over the same universe.
LIVE_LAMBDA_NAMES=$(aws lambda list-functions --query "Functions[?starts_with(FunctionName,'awsops-') && !starts_with(FunctionName,'awsops-v2-')].FunctionName" --output json)
UNEXPECTED_LAMBDAS=$(comm -13 <(printf '%s\n' "${LAMBDAS[@]}" | sort -u) <(echo "$LIVE_LAMBDA_NAMES" | jq -r '.[]' | sort -u))
LIVE_GATEWAY_IDS=$(aws bedrock-agentcore-control list-gateways --query "items[?starts_with(name,'awsops-') && !starts_with(name,'awsops-v2-')].gatewayId" --output json)
UNEXPECTED_GATEWAYS=$(comm -13 <(printf '%s\n' "${GATEWAYS[@]}" | sort -u) <(echo "$LIVE_GATEWAY_IDS" | jq -r '.[]' | sort -u))
LIVE_MEMORY_IDS=$(aws bedrock-agentcore-control list-memories --query "memories[?starts_with(id,'awsops_memory')].id" --output json)
UNEXPECTED_MEMORIES=$(comm -13 <(printf '%s\n' "awsops_memory-IULWInAGhc" | sort -u) <(echo "$LIVE_MEMORY_IDS" | jq -r '.[]' | sort -u))
LIVE_INTERPRETER_IDS=$(aws bedrock-agentcore-control list-code-interpreters --query "codeInterpreterSummaries[?name=='awsops_code_interpreter'].codeInterpreterId" --output json)
UNEXPECTED_INTERPRETERS=$(comm -13 <(printf '%s\n' "awsops_code_interpreter-AIOOg6hlCQ" | sort -u) <(echo "$LIVE_INTERPRETER_IDS" | jq -r '.[]' | sort -u))
if [ -n "$UNEXPECTED_LAMBDAS" ] || [ -n "$UNEXPECTED_GATEWAYS" ] || [ -n "$UNEXPECTED_MEMORIES" ] || [ -n "$UNEXPECTED_INTERPRETERS" ]; then
  echo "WARNING: live AWS state has v1 resource(s) outside this script's hardcoded lists — the runbook's mandatory step (b) has not been satisfied for these:" >&2
  [ -n "$UNEXPECTED_LAMBDAS" ] && printf '  unexpected Lambda: %s\n' $UNEXPECTED_LAMBDAS >&2
  [ -n "$UNEXPECTED_GATEWAYS" ] && printf '  unexpected gateway id: %s\n' $UNEXPECTED_GATEWAYS >&2
  [ -n "$UNEXPECTED_MEMORIES" ] && printf '  unexpected memory id: %s\n' $UNEXPECTED_MEMORIES >&2
  [ -n "$UNEXPECTED_INTERPRETERS" ] && printf '  unexpected code interpreter id: %s\n' $UNEXPECTED_INTERPRETERS >&2
  if [ "${AWSOPS_V1_TEARDOWN_CONFIRM:-}" = "yes" ]; then
    echo "ABORT: refusing to delete anything until the unexpected resource(s) above are triaged and either added to this script's hardcoded lists or excluded with a documented reason." >&2
    exit 1
  fi
  echo "(dry run continues below for informational purposes; AWSOPS_V1_TEARDOWN_CONFIRM=yes will ABORT until this is resolved)" >&2
fi

# Human-confirmation gate (the runbook's mandatory confirmation step): bare execution is a DRY RUN
# that resolves live state and prints what WOULD be deleted. Real deletion requires
# AWSOPS_V1_TEARDOWN_CONFIRM=yes.
# CI-review MAJOR fix: this used to be a bare `CONFIRM` — a common, easily-inherited env var name
# (an operator or CI runner exporting CONFIRM for some unrelated tool would silently defeat this
# script's primary safety mechanism, the dry-run default). Namespaced to avoid collision.
# Every read call in this DRY-RUN branch is individually guarded by `if`, so a read error here
# can never trip set -e (the loop below just reports that resource as unreadable and moves on).
# CI-review MAJOR fix: every existence check below used to collapse a failed read straight to
# "already gone" — a throttle, expired credential, or AccessDenied printed the same line as a
# genuinely deleted resource. This is the runbook's mandatory human-confirmation basis for an
# IRREVERSIBLE deletion, so understating what AWSOPS_V1_TEARDOWN_CONFIRM=yes will destroy is
# exactly backwards from this script's fail-loud posture (already correct in the verification
# block's three-state present/gone/indeterminate treatment — the same NOT_FOUND_RE match now used
# here too, not "any failure = gone").
if [ "${AWSOPS_V1_TEARDOWN_CONFIRM:-}" != "yes" ]; then
  echo "=== DRY RUN (AWSOPS_V1_TEARDOWN_CONFIRM!=yes) — resolving current state, deleting nothing ==="
  echo "--- Lambda functions ---"
  for fn in "${LAMBDAS[@]}"; do
    if out=$(aws lambda get-function --function-name "$fn" --query 'Configuration.FunctionName' --output text 2>&1); then
      echo "  would delete: $fn (exists)"
    elif echo "$out" | grep -qiE "$NOT_FOUND_RE"; then
      echo "  already gone: $fn"
    else
      echo "  INDETERMINATE (real error, not confirmed gone): $fn ($out)"
    fi
  done
  echo "--- deploy bucket ---"
  if head_out=$(aws s3api head-bucket --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" 2>&1); then
    # CI-review MAJOR fix: this used to count via list-objects-v2 (current-version keys only) while
    # the actual delete path below drains list-object-versions (ALL noncurrent versions + delete
    # markers too) — on a versioned bucket the dry-run number could be far below what
    # AWSOPS_V1_TEARDOWN_CONFIRM=yes actually destroys. Count via the SAME call the delete path
    # uses, paginated (read-only — nothing is deleted here), bounded to the same 100-page cap as a
    # sanity limit.
    dry_total=0
    dry_next_token=""
    for i in $(seq 1 100); do
      if [ -n "$dry_next_token" ]; then
        dry_page=$(aws s3api list-object-versions --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" --max-items 1000 --starting-token "$dry_next_token" --query '{Objects: [Versions[].Key, DeleteMarkers[].Key][], NextToken: NextToken}' --output json)
      else
        dry_page=$(aws s3api list-object-versions --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" --max-items 1000 --query '{Objects: [Versions[].Key, DeleteMarkers[].Key][], NextToken: NextToken}' --output json)
      fi
      dry_total=$((dry_total + $(echo "$dry_page" | jq '.Objects | length')))
      dry_next_token=$(echo "$dry_page" | jq -r '.NextToken // ""')
      [ -z "$dry_next_token" ] && break
    done
    # This bucket is also documented (docs/runbooks/cognito-auth-issues.md) to hold CloudFront
    # access-log content under cloudfront-logs/ — call that out explicitly rather than letting the
    # operator confirm against a bare object count with no sense of what's actually in it.
    # MINOR fix: the 100-page cap can exhaust with dry_next_token still set (more pages remain) —
    # silently reporting that partial dry_total as "the" count understates it just like the
    # confirm path's own 100-batch cap (which instead fails loud); mark it explicitly as a
    # lower bound instead.
    dry_count_label="$dry_total"
    [ -n "$dry_next_token" ] && dry_count_label="≥$dry_total (truncated at 100 pages)"
    echo "  would empty + delete: awsops-deploy-180294183052 ($dry_count_label object version(s)/delete marker(s) across all versions — includes cloudfront-logs/ CloudFront access-log content, see docs/runbooks/cognito-auth-issues.md)"
  else
    echo "  already gone or inaccessible: awsops-deploy-180294183052 ($head_out)"
  fi
  echo "--- AgentCore gateways ---"
  for gw in "${GATEWAYS[@]}"; do
    if gw_info=$(aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw" --query '{name:name,status:status}' --output json 2>&1); then
      # CI-review MAJOR fix: bare `[]` (no backticks) on the right of `||` is NOT an empty-array
      # JSON literal in JMESPath — it's the flatten operator applied to the CURRENT node (here,
      # the whole response object), which on a non-array yields `null`; `length(null)` is then a
      # JMESPath type error. Confirmed empirically (python jmespath lib): `items || []` on an
      # empty `items` returns `None`, and `length()` on that raises. The backtick form
      # `` `[]` `` is the actual JSON-literal empty array `length()` needs; verified to return 0.
      if ! tgt_count=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" --query 'length(items || `[]`)' --output text 2>&1); then
        tgt_count="unknown ($tgt_count)"
      fi
      echo "  would delete: $gw ($gw_info, $tgt_count target(s))"
    elif echo "$gw_info" | grep -qiE "$NOT_FOUND_RE"; then
      echo "  already gone: $gw"
    else
      echo "  INDETERMINATE (real error, not confirmed gone): $gw ($gw_info)"
    fi
  done
  echo "--- memory ---"
  if mem_info=$(aws bedrock-agentcore-control get-memory --memory-id awsops_memory-IULWInAGhc --query '{id:id,status:status}' --output json 2>&1); then
    echo "  would delete: awsops_memory-IULWInAGhc ($mem_info)"
  elif echo "$mem_info" | grep -qiE "$NOT_FOUND_RE"; then
    echo "  already gone: awsops_memory-IULWInAGhc"
  else
    echo "  INDETERMINATE (real error, not confirmed gone): awsops_memory-IULWInAGhc ($mem_info)"
  fi
  echo "--- code interpreter ---"
  if ci_info=$(aws bedrock-agentcore-control get-code-interpreter --code-interpreter-id awsops_code_interpreter-AIOOg6hlCQ --query 'status' --output text 2>&1); then
    echo "  would delete: awsops_code_interpreter-AIOOg6hlCQ (status=$ci_info)"
  elif echo "$ci_info" | grep -qiE "$NOT_FOUND_RE"; then
    echo "  already gone: awsops_code_interpreter-AIOOg6hlCQ"
  else
    echo "  INDETERMINATE (real error, not confirmed gone): awsops_code_interpreter-AIOOg6hlCQ ($ci_info)"
  fi
  echo ""
  echo "=== DRY-RUN complete — nothing deleted. Re-run with AWSOPS_V1_TEARDOWN_CONFIRM=yes to execute. ==="
  exit 0
fi

# Re-run safety: a prior partial run (interrupted, transient error, Ctrl-C) may have already
# deleted some resources. Re-running this script must finish the rest, not die on the first
# "already gone" resource. delete_or_skip distinguishes "already deleted" (idempotent success)
# from a REAL error (permission denied, wrong ARN, etc.) by inspecting the AWS CLI's own error
# text — only a recognized not-found signature is swallowed; anything else re-raises and aborts
# (fail loud), so this never silently treats a genuine failure as success.
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
  # Used for single-shot checks; poll_until_gone below does NOT use this (see its own comment).
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
poll_until_gone() {
  # $1 = description (for logging), rest = a "get/describe this one resource" command.
  # CI-review MAJOR fix: this used to call resource_exists in the poll loop, but resource_exists
  # hard-exits (`exit 1`) on any non-not-found error — a SINGLE transient error (throttle, expired
  # creds) anywhere across up to 60 iterations (5 minutes) killed the ENTIRE script well past
  # deletions already accepted, skipping the SKIPPED summary and the whole verification block.
  # This poll is self-contained instead: a transient error is treated the same conservative way
  # this script treats any other "can't confidently tell" case — keep retrying, never abort here.
  # Only a NOT_FOUND match ends the poll early (confirmed gone); running out of attempts (whether
  # from genuine DELETING or from repeated errors) returns 1 to the caller, which routes to
  # SKIPPED — caught by the verification block's own FAIL check, never a silent false success.
  local desc="$1"; shift
  local attempts=0
  local out
  while [ "$attempts" -lt 60 ]; do
    if out=$("$@" 2>&1); then
      : # still exists — keep polling
    elif echo "$out" | grep -qiE "$NOT_FOUND_RE"; then
      echo "  already gone: $desc"
      return 0
    else
      echo "  transient error polling $desc (will retry): $out" >&2
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  return 1
}

SKIPPED=()

echo "=== 4.4: deleting 21 orphan v1 Lambda functions (17 *-mcp slices + aws-knowledge, reachability-analyzer, flow-monitor, steampipe-query, idempotent) ==="
for fn in "${LAMBDAS[@]}"; do
  delete_or_skip "lambda:$fn" aws lambda delete-function --function-name "$fn"
done

echo "=== 4.4: emptying + deleting v1 deploy bucket (v1 diagnosis reports + cloudfront-logs/) ==="
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
    # CI-review MAJOR fix: `--max-items 1000` only bounds the PRIMARY result key of a paginated
    # call (`Versions`) — `DeleteMarkers` from the same aggregated page rides along uncounted, so
    # on a bucket with delete markers this combined `.Objects` array can hold MORE than 1000
    # entries. `delete-objects` hard-rejects a request over 1000 keys, which `delete_or_skip`
    # then reports as a real error and `set -e` aborts the whole drain. Chunk to <=1000 per call.
    chunk_offset=0
    while [ "$chunk_offset" -lt "$count" ]; do
      chunk=$(echo "$page" | jq -c ".Objects[$chunk_offset:$((chunk_offset + 1000))] | {Objects: ., Quiet: true}")
      delete_or_skip "batch of $(echo "$chunk" | jq '.Objects | length') object version(s) in awsops-deploy-180294183052 (offset $chunk_offset of $count)" \
        aws s3api delete-objects --bucket awsops-deploy-180294183052 --expected-bucket-owner "$EXPECTED_ACCOUNT" --delete "$chunk"
      chunk_offset=$((chunk_offset + 1000))
    done
  done
  if [ "$emptied" != "1" ]; then
    echo "REAL ERROR: bucket awsops-deploy-180294183052 did not empty after 100 batches" >&2
    exit 1
  fi
  delete_or_skip "bucket awsops-deploy-180294183052" aws s3api delete-bucket --bucket "awsops-deploy-180294183052" --expected-bucket-owner "$EXPECTED_ACCOUNT"
fi

echo "=== 4.5: AgentCore orphans (idempotent) ==="
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
    # CI-review MAJOR fixes, two together: (1) same bare-`[]`-vs-backtick-`` `[]` `` JMESPath bug
    # as the dry-run branch above — `length(items || [])` on a just-emptied target list (the
    # SUCCESS case this loop is polling for) evaluated to `length(null)`, a JMESPath type error,
    # which the old code treated as fatal — the confirmed run aborted at the exact moment
    # draining succeeded. (2) that same "any error is fatal" `exit 1` also killed the whole
    # script on a single transient throttle/credential blip, the identical class of bug
    # poll_until_gone above was rewritten to tolerate — this loop still hard-aborted. Both fixed
    # the same way now: a transient error retries within the attempt budget instead of exiting.
    if ! remaining=$(aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$gw" --query 'length(items || `[]`)' --output text 2>&1); then
      echo "  transient error polling target count for $gw (will retry): $remaining" >&2
      attempts=$((attempts + 1))
      sleep 5
      continue
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
  # delete-gateway is async (same as delete-memory below) — confirm it's actually gone before
  # moving on, or a stalled deletion silently reaches the verification block's status!=DELETING
  # filter and produces a false ALL CLEAR.
  if ! poll_until_gone "gateway $gw" aws bedrock-agentcore-control get-gateway --gateway-identifier "$gw"; then
    echo "게이트웨이 삭제가 5분 넘게 안 끝남 — 이 게이트웨이는 건너뜀: $gw" >&2
    SKIPPED+=("gateway:$gw (deletion never confirmed drained — rerun this script later to retry)")
  fi
done

echo "--- deleting memory ---"
delete_or_skip "memory awsops_memory-IULWInAGhc" aws bedrock-agentcore-control delete-memory --memory-id awsops_memory-IULWInAGhc
# delete-memory is async (status goes to DELETING, not gone immediately) — a status of DELETING is
# NOT "fully removed", it's still in progress and could stall or fail. Poll until it's actually
# gone (get-memory returns not-found) before treating this as done.
if ! poll_until_gone "memory awsops_memory-IULWInAGhc" aws bedrock-agentcore-control get-memory --memory-id awsops_memory-IULWInAGhc; then
  echo "메모리 삭제가 5분 넘게 안 끝남 — rerun this script later to retry" >&2
  SKIPPED+=("memory:awsops_memory-IULWInAGhc (deletion never confirmed drained)")
fi

echo "--- deleting code interpreter ---"
delete_or_skip "code interpreter awsops_code_interpreter-AIOOg6hlCQ" aws bedrock-agentcore-control delete-code-interpreter --code-interpreter-id awsops_code_interpreter-AIOOg6hlCQ
# Same async-deletion gap as gateway/memory above — delete-code-interpreter succeeding is not
# "gone yet" either; confirm before letting the verification block's DELETING filter trust it.
if ! poll_until_gone "code interpreter awsops_code_interpreter-AIOOg6hlCQ" aws bedrock-agentcore-control get-code-interpreter --code-interpreter-id awsops_code_interpreter-AIOOg6hlCQ; then
  echo "코드 인터프리터 삭제가 5분 넘게 안 끝남 — rerun this script later to retry" >&2
  SKIPPED+=("code-interpreter:awsops_code_interpreter-AIOOg6hlCQ (deletion never confirmed drained)")
fi

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
