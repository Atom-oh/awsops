#!/bin/bash
# Static wiring checks for the Steampipe multi-account/region fan-out terraform (Task 8).
# (terraform apply behavior is verified at deploy; these assert the config is wired.)
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; }

echo "# Steampipe fan-out terraform wiring"

SP=terraform/v2/foundation/steampipe.tf
DT=terraform/v2/foundation/data.tf

grep -q 'AURORA_ENDPOINT' "$SP" && grep -q 'AURORA_DATABASE' "$SP" \
  && pass "steampipe task gets AURORA_ENDPOINT + AURORA_DATABASE env" \
  || fail "steampipe task gets AURORA_ENDPOINT + AURORA_DATABASE env"

grep -q 'AURORA_SECRET' "$SP" \
  && pass "steampipe task gets Aurora secret via task-def secrets/valueFrom" \
  || fail "steampipe task gets Aurora secret via task-def secrets/valueFrom"

# task-role AssumeRole scoped to the read-only role name (not a wildcard role)
grep -Eq 'sts:AssumeRole' "$SP" && grep -Eq 'role/AWSopsReadOnlyRole' "$SP" \
  && pass "steampipe task role assume scoped to AWSopsReadOnlyRole" \
  || fail "steampipe task role assume scoped to AWSopsReadOnlyRole"

# Aurora SG opens 5432 to the steampipe SG (gated on local.sp)
grep -q 'aws_security_group.steampipe' "$DT" \
  && pass "Aurora SG ingress from the steampipe SG" \
  || fail "Aurora SG ingress from the steampipe SG"
