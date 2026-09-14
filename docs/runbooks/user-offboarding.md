# Runbook: User Offboarding

End a departing user's login, administrator access, schedules, and existing sessions. Disabling
Cognito alone does not revoke the self-contained ID token (up to 12 hours under ADR-002) or stop scheduled diagnosis. ADR-002's
`admin_only` recovery closes mailbox-based password recovery; it does not end a password/session
the departing user already holds. Repository commands checked **2026-09-13**; no account was changed.

## Symptom and candidate causes

Use for a departure or an unrecognized account in a roster review. Check for an enabled Cognito user,
standing SSM/admin-group authority, active report schedules, or a missing session-revocation cutoff.
The signup restriction stops new public registrations, not accounts created earlier.
While `legacy_email_owner_match=true`, reassigned verified addresses can still match legacy rows;
complete ownership migration under ADR-009 separately. Do not guess historical ownership.

## Verification

Run from the intended checkout on a host that can reach Aurora. Required tools: AWS CLI v2 with
ISO-8601 timestamp output, Terraform,
psql, and jq. Use the configured AWS profile/region and verify caller identity. The operator must have
`rds-db:connect` for `awsops_web` plus the required Cognito/SSM permissions. No master-secret fallback.
The blocks below are for a human at a terminal; addresses are read literally, not pasted into shell code.

```bash
set -euo pipefail
export AWS_REGION=${AWS_REGION:-ap-northeast-2}
aws sts get-caller-identity
V2_POOL=$(terraform -chdir=terraform/v2/foundation output -raw cognito_user_pool_id)
AURORA_ENDPOINT=$(terraform -chdir=terraform/v2/foundation output -raw aurora_endpoint)
OFFBOARD_DATABASE=$(terraform -chdir=terraform/v2/foundation output -raw aurora_database)
: "${V2_POOL:?No Cognito pool output}"
[[ "$AURORA_ENDPOINT" =~ ^[A-Za-z0-9.-]+\.rds\.amazonaws\.com$ ]] || exit 1
[[ "$OFFBOARD_DATABASE" =~ ^[A-Za-z0-9_]+$ ]] || exit 1
: "${SSM_ADMIN_EMAILS_PARAM:?Set the SSM_ADMIN_EMAILS_PARAM used by the deployed web task}"
OFFBOARD_ADMIN_GROUP=${ADMIN_GROUP:-admins}
DSN="postgresql://awsops_web@${AURORA_ENDPOINT}:5432/${OFFBOARD_DATABASE}?sslmode=require"
refresh_offboard_db_token() {
  PGPASSWORD=$(aws rds generate-db-auth-token --region "$AWS_REGION" \
    --hostname "$AURORA_ENDPOINT" --port 5432 --username awsops_web)
  : "${PGPASSWORD:?No IAM database token returned}"
  export PGPASSWORD
}
aws cognito-idp describe-user-pool --region "$AWS_REGION" --user-pool-id "$V2_POOL" \
  --query 'UserPool.{signup:AdminCreateUserConfig.AllowAdminCreateUserOnly,recovery:AccountRecoverySetting}'
```

Confirm admin-create-only and `admin_only` recovery against the real pool; code/defaults do not prove
application. The connection recipe validates each component so an empty endpoint cannot turn into a
nonempty but wrong DSN. Refresh the IAM token before connections; never print it.
Match `SSM_ADMIN_EMAILS_PARAM` and the admin-group setting to the deployed web task definition.
The parameter path includes the actual project prefix; do not assume `/ops/awsops-v2/admin_emails`
belongs to the deployment being offboarded.

```bash
set -euo pipefail
: "${V2_POOL:?Run connection setup first}"
: "${DSN:?Run connection setup first}"
unset EMAIL SUB
printf 'departing address: '
IFS= read -r EMAIL < /dev/tty
: "${EMAIL:?No address entered}"
aws cognito-idp list-users --region "$AWS_REGION" --user-pool-id "$V2_POOL" \
  --query 'Users[].{u:Username,sub:Attributes[?Name==`sub`]|[0].Value,created:UserCreateDate,status:UserStatus,enabled:Enabled}' \
  --output table
SUB=$(aws cognito-idp admin-get-user --region "$AWS_REGION" \
  --user-pool-id "$V2_POOL" --username "$EMAIL" \
  --query 'UserAttributes[?Name==`sub`]|[0].Value' --output text)
[[ "$SUB" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo 'No valid sub; stop'; exit 1; }
refresh_offboard_db_token
psql -X "$DSN" -v ON_ERROR_STOP=1 -v sub="$SUB" -v email="$EMAIL" <<'SQL'
SELECT 'schedules' AS kind, count(*) FROM report_schedules
WHERE user_sub IN (:'sub', :'email') AND enabled
UNION ALL
SELECT 'reports', count(*) FROM diagnosis_reports
WHERE requested_by IN (:'sub', :'email') AND deleted_at IS NULL;
SQL
```

Use quoted SQL heredocs with `psql -v` so psql safely quotes values as `:'name'`. Do not put those
variables in `psql -c`: that form sends server SQL without psql variable processing.
`ON_ERROR_STOP=1` prevents an SQL failure from appearing to complete the procedure.

## Action

Require a fresh terminal confirmation and re-resolve the sub. Database-independent steps run first:
**disable user → remove SSM/admin-group authority → disable schedules → revoke sessions**.
A database outage must not prevent the first two steps. This block deliberately does not delete the user.

```bash
set -euo pipefail
: "${V2_POOL:?Run Verification first}"
: "${DSN:?Run Verification first}"
: "${EMAIL:?Run Verification first}"
: "${SUB:?Run Verification first}"
: "${SSM_ADMIN_EMAILS_PARAM:?Run connection setup first}"
: "${OFFBOARD_ADMIN_GROUP:?Run connection setup first}"
declare -F refresh_offboard_db_token >/dev/null || { echo 'Run connection setup first'; exit 1; }
printf 'Offboard EMAIL=%s SUB=%s in pool %s. Retype address: ' "$EMAIL" "$SUB" "$V2_POOL"
IFS= read -r CONFIRM < /dev/tty
[ "$CONFIRM" = "$EMAIL" ] || { echo 'Mismatch; nothing changed'; exit 1; }
SUB_NOW=$(aws cognito-idp admin-get-user --region "$AWS_REGION" \
  --user-pool-id "$V2_POOL" --username "$EMAIL" \
  --query 'UserAttributes[?Name==`sub`]|[0].Value' --output text)
[ "$SUB_NOW" = "$SUB" ] || { echo 'Identity changed; stop'; exit 1; }

aws cognito-idp admin-disable-user --region "$AWS_REGION" \
  --user-pool-id "$V2_POOL" --username "$EMAIL"
aws ssm get-parameter --region "$AWS_REGION" --name "$SSM_ADMIN_EMAILS_PARAM" \
  --query Parameter.Value --output text
printf 'Remaining admin emails, comma-separated (one space for groups-only): '
IFS= read -r ADMIN_LIST < /dev/tty
: "${ADMIN_LIST:?Enter the reviewed list or one space}"
EMAIL_LC=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')
ADMIN_LIST_LC=$(printf '%s' "$ADMIN_LIST" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
case ",$ADMIN_LIST_LC," in *,"$EMAIL_LC",*) echo 'Departing address still listed'; exit 1;; esac
aws ssm put-parameter --region "$AWS_REGION" --name "$SSM_ADMIN_EMAILS_PARAM" \
  --type StringList --overwrite --value "$ADMIN_LIST"
OFFBOARD_GROUPS=$(aws cognito-idp admin-list-groups-for-user --region "$AWS_REGION" \
  --user-pool-id "$V2_POOL" --username "$EMAIL" --query 'Groups[].GroupName' --output json)
if printf '%s' "$OFFBOARD_GROUPS" | jq -e --arg g "$OFFBOARD_ADMIN_GROUP" 'index($g) != null' >/dev/null; then
  aws cognito-idp admin-remove-user-from-group --region "$AWS_REGION" \
    --user-pool-id "$V2_POOL" --username "$EMAIL" --group-name "$OFFBOARD_ADMIN_GROUP"
fi

# Aurora work begins only after the independent access controls above.
refresh_offboard_db_token
psql -X "$DSN" -v ON_ERROR_STOP=1 -v sub="$SUB" -v email="$EMAIL" <<'SQL'
UPDATE report_schedules SET enabled = false WHERE user_sub IN (:'sub', :'email');
INSERT INTO session_revocations (user_sub, revoked_at) VALUES (:'sub', NOW())
ON CONFLICT (user_sub) DO UPDATE SET revoked_at = NOW()
WHERE session_revocations.revoked_at < NOW();
SQL
unset PGPASSWORD
```

A single-space StringList means Cognito-group-only administration; Terraform ignores runtime value
changes to this parameter. Allowlist cache propagation can take five minutes. Group removal affects
new tokens; existing group claims survive for up to the 12-hour token lifetime or effective BFF revocation.
Revocation has a five-second per-task cache and fails open during Aurora failure (ADR-002).
If an operation fails, record what completed and resume at that operation; schedules and old sessions can
remain active until the DB steps succeed. Do not label partial offboarding complete.

### After the grace period — run separately

Deletion is irreversible and leaves historical sub-owned rows. After the actual approved grace period,
**rerun connection setup in the current shell**, then this block re-prompts and verifies completion.
A disabled flag alone is insufficient: check schedules, a cutoff newer than this account's last
modification, and removed admin authority. Preserve the sub/evidence before deletion.

```bash
set -euo pipefail
: "${DSN:?Rerun connection setup with a fresh IAM token}"
: "${SSM_ADMIN_EMAILS_PARAM:?Rerun connection setup}"
: "${OFFBOARD_ADMIN_GROUP:?Rerun connection setup}"
declare -F refresh_offboard_db_token >/dev/null || { echo 'Rerun connection setup'; exit 1; }
V2_POOL=$(terraform -chdir=terraform/v2/foundation output -raw cognito_user_pool_id)
: "${V2_POOL:?No Cognito pool output}"
unset EMAIL SUB
printf 'Address to DELETE after the approved grace period: '
IFS= read -r EMAIL < /dev/tty
: "${EMAIL:?No address entered}"
USER_JSON=$(aws cognito-idp admin-get-user --region "$AWS_REGION" \
  --user-pool-id "$V2_POOL" --username "$EMAIL" --output json)
SUB=$(printf '%s' "$USER_JSON" | jq -er '.UserAttributes[] | select(.Name=="sub") | .Value')
RESOLVED_USERNAME=$(printf '%s' "$USER_JSON" | jq -er '.Username')
[[ "$SUB" =~ ^[0-9a-fA-F-]{36}$ ]] || exit 1
printf '%s' "$USER_JSON" | jq -e '.Enabled == false' >/dev/null || {
  echo 'User is not confirmed disabled; stop'; exit 1;
}
MODIFIED=$(printf '%s' "$USER_JSON" | jq -er '.UserLastModifiedDate')
refresh_offboard_db_token
DB_CHECK=$(psql -X "$DSN" -At -v ON_ERROR_STOP=1 \
  -v sub="$SUB" -v email="$EMAIL" -v modified="$MODIFIED" <<'SQL'
SELECT (SELECT count(*) FROM report_schedules
        WHERE user_sub IN (:'sub', :'email') AND enabled),
       (SELECT count(*) FROM session_revocations
        WHERE user_sub = :'sub' AND revoked_at >= :'modified'::timestamptz);
SQL
)
[ "$DB_CHECK" = '0|1' ] || { echo 'Schedule/revocation cleanup incomplete'; exit 1; }
ALLOW=$(aws ssm get-parameter --region "$AWS_REGION" --name "$SSM_ADMIN_EMAILS_PARAM" \
  --query Parameter.Value --output text)
EMAIL_LC=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')
ALLOW_LC=$(printf '%s' "$ALLOW" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
case ",$ALLOW_LC," in *,"$EMAIL_LC",*) echo 'Still in admin allowlist'; exit 1;; esac
OFFBOARD_GROUPS=$(aws cognito-idp admin-list-groups-for-user --region "$AWS_REGION" \
  --user-pool-id "$V2_POOL" --username "$EMAIL" --query 'Groups[].GroupName' --output json)
printf '%s' "$OFFBOARD_GROUPS" | jq -e --arg g "$OFFBOARD_ADMIN_GROUP" 'index($g) == null' >/dev/null || {
  echo 'Admin-group removal is not confirmed; stop'; exit 1;
}

# Full Terraform JSON can contain credentials. Keep this direct pipe: only managed
# Cognito usernames enter TF_USERS. Do not print/cache raw state or insert tee.
# Any read/parse failure aborts.
TF_USERS=$(terraform -chdir=terraform/v2/foundation show -json | jq -r '
  if (.values.root_module | type) != "object" then error("No readable foundation state")
  else .values.root_module | .. | objects
    | select(.type? == "aws_cognito_user" and has("values"))
    | .values.username // error("Managed Cognito user has no username")
  end')
: "${TF_USERS:?No managed Cognito users found; verify the foundation root/workspace before deletion}"
USERNAME_LC=$(printf '%s' "$RESOLVED_USERNAME" | tr '[:upper:]' '[:lower:]')
while IFS= read -r TF_USER; do
  [ -n "$TF_USER" ] || continue
  TF_USER_LC=$(printf '%s' "$TF_USER" | tr '[:upper:]' '[:lower:]')
  [ "$TF_USER_LC" != "$EMAIL_LC" ] && [ "$TF_USER_LC" != "$USERNAME_LC" ] || {
    echo 'Terraform manages this user; resolve ownership through a reviewed infrastructure change'; exit 1;
  }
done <<< "$TF_USERS"
printf 'Verified EMAIL=%s SUB=%s pool=%s. Retype to delete irreversibly: ' "$EMAIL" "$SUB" "$V2_POOL"
IFS= read -r CONFIRM < /dev/tty
[ "$CONFIRM" = "$EMAIL" ] || { echo 'Mismatch; not deleted'; exit 1; }
aws cognito-idp admin-delete-user --region "$AWS_REGION" --user-pool-id "$V2_POOL" --username "$EMAIL"
unset PGPASSWORD
```

An empty/unavailable Terraform state is not evidence that the user is unmanaged. Verify the initialized
backend/environment before this step; if ownership is uncertain, stop. A Terraform-managed admin must
be transferred/removed by a separately reviewed configuration/state change or the next apply may
recreate it. Do not remove state entries as a shortcut in this account-deletion block.

## Related

[ADR-002](../decisions/002-auth-and-login.md), [ADR-009](../decisions/009-async-worker-backbone.md),
`web/lib/{auth,admin}.ts`, `terraform/v2/foundation/{auth,workload}.tf`, `scripts/v2/backfill-owner-sub.mjs`.
