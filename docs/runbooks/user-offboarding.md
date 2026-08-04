# Runbook: 사용자 오프보딩 (Cognito) / User Offboarding (Cognito)

사람이 떠날 때 v2 Cognito 계정을 처리하는 절차. **미룰 수 없는 이유**: 계정을 남겨두면 그 email 주소가
재할당되는 순간 새 보유자가 그 계정을 인수할 수 있고, 인수되면 email-keyed 행뿐 아니라 **sub-keyed 행까지
전부** 넘어간다.

What to do with a v2 Cognito account when a person leaves. **Why it cannot wait**: leave the account alive
and, the moment the email address is reassigned, the new holder can take the account over — which hands
them the sub-keyed rows too, not just the email-keyed ones.

## 증상 / Symptom
떠난 사람의 리소스가 다른 사람 화면에 보이거나, 떠난 사람 명의로 진단·스케줄이 계속 실행된다. 또는
정기 명부 감사에서 pool 에 알 수 없는 사용자가 있다.

A departed person's resources appear under someone else, diagnoses or schedules keep running in their
name, or a roster audit finds users in the pool nobody recognises.

## 원인 후보 / Candidate causes
1. **계정이 그대로 살아 있다** — 오프보딩에서 Cognito 를 건드리지 않았다. 가장 흔하다.
2. **주소 재할당 + 계정 복구** — `ForgotPassword`/`ConfirmForgotPassword` 는 무서명 public API 이고 확인
   코드는 그 계정의 email 로 간다. mailbox 를 쥔 사람이 곧 계정 보유자가 된다. `write_attributes` 축소도
   `allow_admin_create_user_only` 도 이 경로는 막지 못한다(ADR-002 잔여 위험).
3. **self-registered 잔존 계정** — `allow_admin_create_user_only` 는 앞으로의 signup 만 막는다.

1. **The account is still alive** — offboarding never touched Cognito. The common case.
2. **Address reassignment + account recovery** — `ForgotPassword`/`ConfirmForgotPassword` are unsigned
   public APIs and the code goes to the account's email, so the mailbox holder becomes the account
   holder. Neither the narrowed `write_attributes` nor `allow_admin_create_user_only` blocks this path
   (ADR-002, accepted residual risk).
3. **Leftover self-registered accounts** — `allow_admin_create_user_only` only stops future signups.

## 확인 / Verification
```bash
V2_POOL=$(terraform -chdir=terraform/v2/foundation output -raw cognito_user_pool_id)

# 1) pool 전체를 명부와 대조 / reconcile the whole pool against your roster
aws cognito-idp list-users --user-pool-id "$V2_POOL" \
  --query 'Users[].{u:Username,created:UserCreateDate,status:UserStatus,enabled:Enabled}' --output table

# 2) 그 사람 명의로 남아있는 상태 / what still exists in their name
#    (sub 는 list-users 의 Attributes 에서 확인)
psql -c "SELECT 'schedules' AS what, count(*) FROM report_schedules WHERE user_sub IN ('<sub>','<email>') AND enabled
         UNION ALL SELECT 'reports', count(*) FROM diagnosis_reports WHERE requested_by IN ('<sub>','<email>') AND deleted_at IS NULL"
```

## 조치 / Action
```bash
# 1) 스케줄을 먼저 끈다 — 계정을 지워도 report_schedules 행은 남아 계속 실행된다
#    Disable the schedule FIRST: deleting the account does not remove report_schedules rows, and the
#    dispatcher fires every enabled row regardless of whether the user still exists.
psql -c "UPDATE report_schedules SET enabled = false, updated_at = NOW() WHERE user_sub IN ('<sub>','<email>')"

# 2) 계정 비활성화 (되돌릴 수 있음 — 인수 경로는 즉시 닫힌다)
#    Disable the account (reversible, and it closes the takeover path immediately)
aws cognito-idp admin-disable-user --user-pool-id "$V2_POOL" --username "<email>"

# 3) 유예기간 후 삭제 / delete after your grace period
aws cognito-idp admin-delete-user --user-pool-id "$V2_POOL" --username "<email>"
```

**순서가 중요하다**: 2번만 하고 1번을 빠뜨리면 스케줄이 계속 진단을 돌려 Bedrock 비용이 나가고, 그
결과물은 소유자가 없어 아무에게도 보이지 않는다. **Order matters**: disable the account without disabling
the schedule and the diagnosis keeps running (billed Bedrock) while its output belongs to nobody.

MFA 가 `OFF` 인 현재 상태에서는 **비활성화/삭제가 이 경로의 유일한 확실한 차단**이다. 그리고 `legacy_email_owner_match=true` 인 동안에는 주소가 재할당되면
그 주소로 기록된 legacy 행이 새 보유자와 매칭된다. 컷오버(ADR-009) 이후에는 sub 만 매칭하므로 legacy 행
노출은 사라지지만, **계정 인수 경로는 그대로다**(MFA 를 켜지 않는 한).

With MFA `OFF` as it is today, disabling/deleting is the only certain block for this path. And while
`legacy_email_owner_match=true`, a reassigned address
matches the legacy rows written under it. After the cutover (ADR-009) only the sub matches, so that
exposure ends, but **the account-takeover path does not** unless MFA is turned on.

## 관련 파일 / Related files
- `terraform/v2/foundation/auth.tf` — user pool, `allow_admin_create_user_only`, `write_attributes`, `mfa_configuration`
- `web/lib/auth.ts` — `verifyUser()` (email_verified 게이트), `matchesIdentity()`, `ownerKeysForRead()`, `identityKeys()`
- `scripts/v2/backfill-owner-sub.mjs` — 소유권 컷오버(계정 나이 게이트 포함)
- `docs/runbooks/v1-decommission.md` — v1→v2 사용자 이관 및 pool 명부 대조

## ADR
- **ADR-002** — 인증/로그인, `email_verified` 게이트, 계정 복구 인수 = 수용된 잔여 위험(통제: 이 런북 + MFA)
- **ADR-009** — 소유권 키 컷오버(`legacy_email_owner_match`), backfill 절차
