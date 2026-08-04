# Runbook: 사용자 오프보딩 (Cognito) / User Offboarding (Cognito)

사람이 떠날 때 v2 Cognito 계정을 처리하는 절차. **미룰 수 없는 이유**: 떠난 사람은 자기 비밀번호를 알고 있고,
손에 든 세션 쿠키는 최대 12h 살아 있고, admin allowlist 항목과 예약 진단은 계정과 무관하게 계속 작동한다.
(주소 재할당을 통한 *계정 인수* 는 별개 통제로 닫혀 있다 — ADR-002 의 `account_recovery_setting = admin_only`.)

What to do with a v2 Cognito account when a person leaves. **Why it cannot wait**: the departing person
knows their password, the session cookie in their hand lives for up to 12h, and their admin-allowlist
entry and scheduled diagnoses keep working regardless of the account. (*Takeover* via a reassigned
address is closed by a separate control — `account_recovery_setting = admin_only`, ADR-002.)

## 증상 / Symptom
떠난 사람의 리소스가 다른 사람 화면에 보이거나, 떠난 사람 명의로 진단·스케줄이 계속 실행된다. 또는
정기 명부 감사에서 pool 에 알 수 없는 사용자가 있다.

A departed person's resources appear under someone else, diagnoses or schedules keep running in their
name, or a roster audit finds users in the pool nobody recognises.

## 원인 후보 / Candidate causes
1. **계정이 그대로 살아 있다** — 오프보딩에서 Cognito 를 건드리지 않았다. 가장 흔하다.
2. **주소 재할당 + 계정 복구** — `ForgotPassword`/`ConfirmForgotPassword` 는 무서명 public API 이고 확인
   코드는 그 계정의 email 로 간다. **`account_recovery_setting = admin_only`(ADR-002) 가 이 경로를 닫는다** — 이 런북의 몫이 아니므로,
   pool 설정이 실제로 그렇게 되어 있는지만 확인한다(`describe-user-pool`). 열려 있다면 그건 인프라 회귀이고,
   그 상태에서는 mailbox 를 쥔 사람이 곧 계정 보유자다.
3. **self-registered 잔존 계정** — `allow_admin_create_user_only` 는 앞으로의 signup 만 막는다.

1. **The account is still alive** — offboarding never touched Cognito. The common case.
2. **Address reassignment + account recovery** — `ForgotPassword`/`ConfirmForgotPassword` are unsigned
   public APIs and the code goes to the account's email. **`account_recovery_setting = admin_only` (ADR-002)
   closes this path** — not this runbook's job, so all that is needed here is confirming the pool really
   has it (`describe-user-pool`). If it does not, that is an infrastructure regression, and until it is
   fixed the mailbox holder is the account holder.
3. **Leftover self-registered accounts** — `allow_admin_create_user_only` only stops future signups.

## 확인 / Verification
```bash
# 환경변수는 web task def 와 같은 값 / same values the web task definition uses
SSM_ADMIN_EMAILS_PARAM=${SSM_ADMIN_EMAILS_PARAM:-/ops/awsops-v2/admin_emails}

# 아래 SQL 은 파괴적이다. DSN 이 비어 있으면 psql 이 로컬 소켓에 붙어 엉뚱한 DB 를 건드릴 수 있으므로
# `:?` 로 fail-closed 한다. DSN 은 v1-to-v2-aurora-backfill.md 와 같은 방식으로 준비한다(Aurora
# endpoint + IAM DB auth 토큰; 이 앱도 master secret 이 아니라 IAM 인증을 쓴다).
# The SQL below is destructive. An empty DSN would let psql fall back to a local socket and hit the
# wrong database, so `:?` makes it fail closed. Build DSN the same way as
# v1-to-v2-aurora-backfill.md does (Aurora endpoint + an IAM DB auth token — the app authenticates
# that way too, not with the master secret).
: "${DSN:?set DSN (postgresql://<user>@<aurora-endpoint>:5432/awsops?sslmode=require) first}"
```

```bash
V2_POOL=$(terraform -chdir=terraform/v2/foundation output -raw cognito_user_pool_id)

# 주소는 변수로만 다룬다 — 이 런북의 위협모델이 "명부에 없는 self-registered 계정"이라 주소를 공격자가
# 골랐을 수 있다. `'` 나 `$( )` 가 든 주소를 명령줄에 그대로 치환하면 SQL 오작동/셸 주입이 된다.
# Keep the address in a variable. This runbook's own threat model is "self-registered accounts nobody
# recognises", so the address may be ATTACKER-CHOSEN: pasting one containing `'` or `$( )` straight into a
# command is a SQL or shell injection (review finding).
EMAIL='<email>'          # 따옴표 안에 그대로 / verbatim, inside the quotes

# 1) pool 전체를 명부와 대조 — sub 도 함께 뽑는다(아래 단계들이 요구한다)
#    Reconcile the pool against your roster, and project the sub too: the steps below need it, and the
#    earlier version of this command dropped Attributes while telling you to read the sub from them.
aws cognito-idp list-users --user-pool-id "$V2_POOL" \
  --query 'Users[].{u:Username,sub:Attributes[?Name==`sub`]|[0].Value,created:UserCreateDate,status:UserStatus,enabled:Enabled}' \
  --output table

# 이 한 사람의 sub / this one person's sub
SUB=$(aws cognito-idp admin-get-user --user-pool-id "$V2_POOL" --username "$EMAIL" \
  --query 'UserAttributes[?Name==`sub`]|[0].Value' --output text)
: "${SUB:?admin-get-user returned no sub — check the username}"

# 2) 그 사람 명의로 남아있는 상태 / what still exists in their name.
#    -v + :'name' 로 psql 이 인용을 담당한다 — 문자열 보간이 아니다.
#    psql does the quoting via -v + :'name'; nothing is interpolated into the SQL text.
psql "$DSN" -v sub="$SUB" -v email="$EMAIL" -c \
  "SELECT 'schedules' AS what, count(*) FROM report_schedules WHERE user_sub IN (:'sub', :'email') AND enabled
   UNION ALL SELECT 'reports', count(*) FROM diagnosis_reports WHERE requested_by IN (:'sub', :'email') AND deleted_at IS NULL"
```

## 조치 / Action
```bash
# 이 블록만 복사해 실행하는 경우가 많으므로 가드를 여기에도 둔다 — 위 '확인' 블록에만 있으면 소용없다.
# The guard is repeated here because this is the block people copy on its own; having it only in the
# Verification block above protects nothing. Unset DSN => psql would silently use a local socket.
set -euo pipefail
: "${DSN:?set DSN (postgresql://<user>@<aurora-endpoint>:5432/awsops?sslmode=require) first}"
: "${V2_POOL:?set V2_POOL (terraform -chdir=terraform/v2/foundation output -raw cognito_user_pool_id)}"
: "${SSM_ADMIN_EMAILS_PARAM:=/ops/awsops-v2/admin_emails}"
: "${EMAIL:?set EMAIL to the departing person's address (quoted, verbatim)}"
: "${SUB:?set SUB — see the Verification block's admin-get-user step}"

# 1) 스케줄을 먼저 끈다 — 계정을 지워도 report_schedules 행은 남아 계속 실행된다
#    Disable the schedule FIRST: deleting the account does not remove report_schedules rows, and the
#    dispatcher fires every enabled row regardless of whether the user still exists.
psql "$DSN" -v sub="$SUB" -v email="$EMAIL" -c \
  "UPDATE report_schedules SET enabled = false WHERE user_sub IN (:'sub', :'email')"

# 2) 계정 비활성화 (되돌릴 수 있음 — 인수 경로는 즉시 닫힌다)
#    Disable the account (reversible, and it closes the takeover path immediately)
aws cognito-idp admin-disable-user --user-pool-id "$V2_POOL" --username "$EMAIL"

# 3) 이미 발급된 세션을 끊는다 — admin-disable-user 는 새 로그인만 막고, 손에 든 awsops_token
#    쿠키는 최대 12h 그대로 유효하다. 이 앱은 verifyUser() 가 session_revocations 를 보므로,
#    그 sub 의 cutoff 를 지금으로 올리면 기존 쿠키가 즉시 무효가 된다(캐시 TTL 5초).
#    Cut the session that already exists: admin-disable-user only blocks NEW logins, and the
#    awsops_token cookie in their hand stays valid for up to 12h — Cognito cannot revoke an id_token.
#    verifyUser() consults session_revocations, so advancing this sub's cutoff to now invalidates
#    every cookie issued before it (5s cache TTL). Caveat: isRevoked() is fail-OPEN if Aurora is
#    unreachable (documented in ADR-002), so during a DB outage this step does not hold — steps 2/5 are
#    what survive that. / 단, isRevoked() 는 Aurora 장애 시 fail-open 이므로(ADR-002) DB 장애 중에는
#    이 단계가 보장되지 않는다 — 그때 남는 것은 2/5 단계다.
psql "$DSN" -v sub="$SUB" -c \
  "INSERT INTO session_revocations (user_sub, revoked_at) VALUES (:'sub', NOW())
   ON CONFLICT (user_sub) DO UPDATE SET revoked_at = NOW()
   WHERE session_revocations.revoked_at < NOW()"

# 4) admin 권한 회수 — SSM allowlist 는 EMAIL 로 매칭하므로 계정을 지워도 항목이 남는다.
#    주소가 재할당되고 새 보유자가 그 주소를 verified 로 만들면 그 사람이 admin 이 된다.
#    Revoke standing authority: the SSM admin allowlist matches on EMAIL, so the entry outlives the
#    account. If the address is reassigned and the new holder gets it verified, they become admin.
aws ssm get-parameter --name "$SSM_ADMIN_EMAILS_PARAM" --query Parameter.Value --output text
#    타입은 StringList 다(workload.tf). --type String 으로 덮어쓰면 AWS 가 타입 변경을 거부한다.
#    The parameter is a StringList (workload.tf); passing --type String is rejected — AWS will not
#    change an existing parameter's type on overwrite.
aws ssm put-parameter --name "$SSM_ADMIN_EMAILS_PARAM" --type StringList --overwrite \
  --value "<remaining,comma,separated,emails>"     # 반영까지 최대 5분 (캐시 TTL) / up to 5 min cache TTL
#    마지막 admin 을 지우는 경우 빈 문자열은 거부되므로 공백 하나를 넣는다(= cognito:groups 만 사용).
#    Removing the last entry: an empty value is rejected, so write a single space — that means
#    "cognito:groups only", which is how Terraform seeds it.
#    Terraform 은 이 값에 `ignore_changes` 를 걸어두었으므로 CLI 수정이 다음 apply 로 되돌아가지 않는다.
#    Terraform sets `ignore_changes = [value]` on this parameter, so a CLI edit is not reverted by the
#    next apply.
# admins 그룹에 있었다면 / if they were in the group:
aws cognito-idp admin-remove-user-from-group --user-pool-id "$V2_POOL" \
  --username "$EMAIL" --group-name "${ADMIN_GROUP:-admins}"

# 5) 유예기간 후 삭제 / delete after your grace period
aws cognito-idp admin-delete-user --user-pool-id "$V2_POOL" --username "$EMAIL"
```

**순서가 중요하다**: 2번만 하고 1번을 빠뜨리면 스케줄이 계속 진단을 돌려 Bedrock 비용이 나가고, 그
결과물은 소유자가 없어 아무에게도 보이지 않는다. **Order matters**: disable the account without disabling
the schedule and the diagnosis keeps running (billed Bedrock) while its output belongs to nobody.

**2번만으로는 접근이 끊기지 않는다** — 이것이 이 절차에서 가장 놓치기 쉬운 지점이다. `admin-disable-user`
는 *새* 인증만 막고, id_token 은 서버가 발급 후 취소할 수 없는 자기완결 토큰이다. 3번(세션 revocation)을
하지 않으면 그 사람은 **최대 12시간 더 로그인 상태로 남는다.** 4번도 마찬가지로 잊기 쉽다: allowlist 는
계정이 아니라 **주소**를 신뢰하므로, 항목을 남겨두면 그 주소를 나중에 쥔 사람이 admin 을 물려받는다.

**Step 2 alone does not cut access** — the easiest thing to miss here. `admin-disable-user` blocks only
*new* authentication, and an id_token is self-contained: nothing server-side can retract it once issued.
Skip step 3 and the person stays logged in for **up to 12 more hours**. Step 4 is equally easy to forget:
the allowlist trusts an ADDRESS, not an account, so an entry left behind hands admin to whoever holds that
address next.

**무엇이 무엇을 닫는지는 ADR-002 가 단일 진실이다**(이 런북은 그 문장을 인용만 한다): *계정 복구 인수는*
`account_recovery_setting = admin_only` *가 닫고, 오프보딩은 떠난 사람이 이미 아는 비밀번호·세션·admin 권한을
닫는다.* 그래서 이 절차는 복구 경로를 막기 위한 것이 아니라 **남아 있는 접근**을 끝내기 위한 것이다. 그리고 `legacy_email_owner_match=true` 인 동안에는 주소가 재할당되면
그 주소로 기록된 legacy 행이 새 보유자와 매칭된다. 컷오버(ADR-009) 이후에는 sub 만 매칭하므로 legacy 행
노출은 사라진다. 만료되지 않는 것은 **떠난 사람이 이미 아는 비밀번호**이므로, 계정 자체를 없애야 한다.

**ADR-002 is the single truth on which control closes what** — this runbook only quotes it: *recovery
takeover is closed by* `account_recovery_setting = admin_only`*; offboarding closes the access that a
departing person's already-known password, live session and standing admin rights still provide.* So this
procedure exists to end REMAINING access, not to block the recovery path. And while
`legacy_email_owner_match=true`, a reassigned address
matches the legacy rows written under it. After the cutover (ADR-009) only the sub matches, so that
exposure ends. What never expires is the password the departing person already knows, so the account
itself has to go.

## 관련 파일 / Related files
- `terraform/v2/foundation/auth.tf` — user pool, `allow_admin_create_user_only`, `write_attributes`, `mfa_configuration`
- `web/lib/auth.ts` — `verifyUser()` (email_verified 게이트), `matchesIdentity()`, `ownerKeysForRead()`, `identityKeys()`
- `scripts/v2/backfill-owner-sub.mjs` — 소유권 컷오버(계정 나이 게이트 포함)
- `docs/runbooks/v1-decommission.md` — v1→v2 사용자 이관 및 pool 명부 대조

## ADR
- **ADR-002** — 인증/로그인, `email_verified` 게이트, `account_recovery_setting = admin_only`(계정 복구 인수 차단)
- **ADR-009** — 소유권 키 컷오버(`legacy_email_owner_match`), backfill 절차
