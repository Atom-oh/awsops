#!/bin/bash
# Static wiring checks for the Steampipe multi-account/region fan-out terraform (Task 8).
# (terraform apply behavior is verified at deploy; these assert the config is wired.)
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
FAILS=0
fail() { echo "not ok - $1"; FAILS=$((FAILS+1)); }

echo "# Steampipe fan-out terraform wiring"

SP=terraform/v2/foundation/steampipe.tf
DT=terraform/v2/foundation/data.tf

grep -q 'AURORA_ENDPOINT' "$SP" && grep -q 'AURORA_DATABASE' "$SP" \
  && pass "steampipe task gets AURORA_ENDPOINT + AURORA_DATABASE env" \
  || fail "steampipe task gets AURORA_ENDPOINT + AURORA_DATABASE env"

# M1: no Aurora secret of any kind (master or otherwise) is granted to the steampipe task —
# IAM database auth (rds-db:connect) replaces it entirely. Exact match on the quoted env var name
# ("AURORA_SECRET") so this does NOT false-positive on the unrelated inv-sync lambda's
# AURORA_SECRET_ARN (that Lambda legitimately needs write access via the master secret — out of
# M1's scope, which is specifically the network-listening steampipe task).
grep -Eq '"AURORA_SECRET"' "$SP" \
  && fail "steampipe task must NOT be granted any Aurora secret (M1 — use IAM auth instead)" \
  || pass "steampipe task is not granted any Aurora secret (M1)"

grep -Eq 'rds-db:connect' "$SP" && grep -Eq 'dbuser:.*steampipe_reader' "$SP" \
  && pass "steampipe task role gets rds-db:connect scoped to steampipe_reader (M1 IAM auth)" \
  || fail "steampipe task role gets rds-db:connect scoped to steampipe_reader (M1 IAM auth)"

grep -Eq 'AURORA_USER' "$SP" \
  && pass "steampipe task gets AURORA_USER env (non-secret role name)" \
  || fail "steampipe task gets AURORA_USER env (non-secret role name)"

grep -Eq 'iam_database_authentication_enabled\s*=\s*true' "$DT" \
  && pass "Aurora cluster has IAM database authentication enabled" \
  || fail "Aurora cluster has IAM database authentication enabled"

# task-role AssumeRole scoped to the read-only role name (not a wildcard role)
grep -Eq 'sts:AssumeRole' "$SP" && grep -Eq 'role/AWSopsReadOnlyRole' "$SP" \
  && pass "steampipe task role assume scoped to AWSopsReadOnlyRole" \
  || fail "steampipe task role assume scoped to AWSopsReadOnlyRole"

# M2: inv-sync lambda gets a scoped sts:AssumeRole for the reachability probe (same role name)
grep -c 'sts:AssumeRole' "$SP" | grep -q '^[2-9]' \
  && pass "sts:AssumeRole granted to more than one role (steampipe_task + inv_sync probe, M2)" \
  || fail "sts:AssumeRole granted to more than one role (steampipe_task + inv_sync probe, M2)"

# Aurora SG opens 5432 to the steampipe SG (gated on local.sp)
grep -q 'aws_security_group.steampipe' "$DT" \
  && pass "Aurora SG ingress from the steampipe SG" \
  || fail "Aurora SG ingress from the steampipe SG"

[ "$FAILS" -eq 0 ] || exit 1
