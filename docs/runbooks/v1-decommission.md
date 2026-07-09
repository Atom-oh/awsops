# Runbook — v1 레거시 폐기 / v1 Legacy Decommission

ADR-016 실행 절차. v1(EC2 `i-0a35c902f44f23adf`, CloudFront `E2XR2P3SB6XRME`, 공개 ALB `awsops-alb`)을 5단계로 폐기하고 도메인 `awsops.atomai.click`을 v2로 컷오버한다. 계정 `180294183052` 기준(2026-07-08 조사 시점 식별자 — 실행 전 재확인).
Procedure for ADR-016. Decommissions v1 in five stages and cuts the `awsops.atomai.click` domain over to v2. Account `180294183052` (identifiers as of the 2026-07-08 survey — re-verify before running).

관련 문서 / Related: `docs/decisions/016-v1-decommission.md`, `docs/history/v1-v2-gap-audit-2026-07-09.md`, `docs/runbooks/v1-to-v2-aurora-backfill.md`.

---

## Phase 1 — 데이터 확보 (v1 살아있는 동안) / Data capture (while v1 is still up)

### 1.1 backfill 실행

기존 런북 그대로 실행: `docs/runbooks/v1-to-v2-aurora-backfill.md` §2(v1 `data/` 복사) → §3(dry-run) → 실행 → §5(행수 검증). 멱등이므로 재실행 안전.

```bash
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --account-id <acct> --dry-run
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --account-id <acct>
```

### 1.2 Cognito 사용자 대조

```bash
V1_POOL=$(aws cognito-idp list-user-pools --max-results 20 --query "UserPools[?contains(Name,'Awsops') || contains(Name,'AwsopsCognito')].Id" --output text)
V2_POOL=$(terraform -chdir=terraform/v2/foundation output -raw cognito_user_pool_id)
aws cognito-idp list-users --user-pool-id "$V1_POOL" --query 'Users[].Username' --output text
aws cognito-idp list-users --user-pool-id "$V2_POOL" --query 'Users[].Username' --output text
```

v2에 없는 사용자는 `aws cognito-idp admin-create-user --user-pool-id "$V2_POOL" --username <email> --user-attributes Name=email,Value=<email>`로 초대(임시 비밀번호 발송, 이관 불가 — 재설정 필요).

### 1.3 alert 경로 외부 발신자 확인 (필수 — ADR-016 §Context)

```bash
# AWS 네이티브 경로 구독자
aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:ap-northeast-2:180294183052:awsops-alert-topic

# CloudWatch Alarm이 이 토픽을 action으로 쓰는지
aws cloudwatch describe-alarms --query "MetricAlarms[?contains(AlarmActions,'arn:aws:sns:ap-northeast-2:180294183052:awsops-alert-topic')].AlarmName"
```

사내 Grafana Alerting / Prometheus Alertmanager 설정에서 웹훅 URL이 `awsops.atomai.click/api/alert-webhook` 또는 v1 ALB DNS를 직접 참조하는지 수동 확인. 발견되면:
- v2 `web/app/api/incidents/webhook/route.ts`로 재설정, 또는
- ADR-016에 "확인 완료, 발신자 없음/재설정 완료"로 기록 후 진행.

**이 확인 없이 Phase 3(EC2 정지)로 넘어가지 않는다.**

---

## Phase 2 — 도메인 컷오버 (Terraform) / Domain cutover

### 2.1 v1 CloudFront에서 별칭 제거 (선행)

```bash
aws cloudfront get-distribution-config --id E2XR2P3SB6XRME --query DistributionConfig > /tmp/v1-cf-config.json
# jq로 Aliases.Items에서 "awsops.atomai.click" 제거, ETag 보존 후:
aws cloudfront update-distribution --id E2XR2P3SB6XRME --distribution-config file:///tmp/v1-cf-config-updated.json --if-match <ETag>
```

### 2.2 Terraform 변경 (`terraform/v2/foundation/`)

- `variables.tf`에 `extra_domain_aliases` (list(string), default `[]`) 추가
- `edge.tf`: ACM `subject_alternative_names`, CloudFront `aliases`에 `concat`, Route53 레코드 `for_each`화(+ `moved` 블록)
- `auth.tf`: Cognito callback/logout URL에 `https://awsops.atomai.click/...` 추가
- tfvars에 `extra_domain_aliases=["awsops.atomai.click"]`

```bash
terraform -chdir=terraform/v2/foundation plan -out tfplan
# 컨트롤러가 실행 (CloudFront 긴 apply — 서브에이전트 idle-timeout 회피)
terraform -chdir=terraform/v2/foundation apply tfplan
```

### 2.3 Route53 레코드 소유권 이전

기존 A 레코드는 CFN `AwsopsStack` 소유. Terraform이 같은 이름으로 리소스를 만들려 하면 `EntityAlreadyExists` 류 충돌 발생 가능 →

```bash
terraform -chdir=terraform/v2/foundation import 'aws_route53_record.alias["awsops.atomai.click"]' Z01703432E9KT1G1FIRFM_awsops.atomai.click_A
```

### 2.4 검증

```bash
curl -sI https://awsops.atomai.click | head -5   # v2 응답(302 → /login) 기대
curl -sI https://awsops-v2.atomai.click | head -5 # 기존대로 정상
terraform -chdir=terraform/v2/foundation plan     # No changes 기대
```

---

## Phase 3 — v1 다크 (유예 시작) / Go dark (grace period starts)

```bash
aws ec2 stop-instances --instance-ids i-0a35c902f44f23adf
aws cloudfront get-distribution-config --id E2XR2P3SB6XRME --query DistributionConfig > /tmp/v1-cf-disable.json
# jq로 Enabled=false 로 수정 후:
aws cloudfront update-distribution --id E2XR2P3SB6XRME --distribution-config file:///tmp/v1-cf-disable-updated.json --if-match <ETag>
```

유예 1~2주 관찰. 문제 발생 시 **롤백**:

```bash
aws ec2 start-instances --instance-ids i-0a35c902f44f23adf
# CloudFront Enabled=true로 되돌리고, 필요하면 2.1의 역순으로 별칭도 v1에 복원
```

---

## Phase 4 — 완전 삭제 (유예 후) / Full teardown (after grace period)

```bash
# 4.1 스택 전수 확인
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'Awsops')].StackName"

# 4.2 Lambda@Edge 선처리 — us-east-1, distribution 연결 해제 후 replica 소멸 대기(수 시간)
aws lambda get-function --function-name awsops-cognito-auth --region us-east-1

# 4.3 CDK 스택 삭제 (infra-cdk/ 체크아웃에서)
cd infra-cdk && npx cdk destroy AwsopsStack
# Route53 레코드 충돌 시: aws cloudformation delete-stack --stack-name AwsopsStack --retain-resources DomainARecord

# 4.4 고아 리소스 개별 삭제
for fn in awsops-core-mcp awsops-ecs-mcp awsops-eks-mcp awsops-iam-mcp awsops-iac-mcp \
          awsops-rds-mcp awsops-msk-mcp awsops-cost-mcp awsops-finops-mcp awsops-valkey-mcp \
          awsops-network-mcp awsops-dynamodb-mcp awsops-terraform-mcp awsops-cloudtrail-mcp \
          awsops-cloudwatch-mcp awsops-aws-knowledge awsops-reachability-analyzer awsops-flow-monitor; do
  aws lambda delete-function --function-name "$fn"
done
aws s3 rm s3://awsops-deploy-180294183052 --recursive && aws s3api delete-bucket --bucket awsops-deploy-180294183052
```

**절대 삭제하지 않는 것**: 공유 VPC `vpc-0e1b8458f46f9f81d`(타 서비스 NLB 다수), hosted zone `Z01703432E9KT1G1FIRFM`, `CDKToolkit`, spoke 계정의 `AWSopsReadOnlyRole`(v2 cross-account 조회가 사용), `awsops-docs.atomai.click` CNAME, `awsops-v2-*` 전체.

### 검증

```bash
aws cloudformation list-stacks --query "StackSummaries[?contains(StackName,'Awsops')]"  # 빈 결과 기대
aws lambda list-functions --query "Functions[?starts_with(FunctionName,'awsops-') && !starts_with(FunctionName,'awsops-v2-')].FunctionName"  # 빈 결과 기대
# v2 챗 cross-account 조회 정상 확인 (spoke 롤 생존 확인)
```

---

## Phase 5 — repo 코드 정리 (별도 PR) / Code cleanup (separate PR)

Phase 4 완료 후에만 진행. 삭제 대상: `src/`, `infra-cdk/`, `scripts/0N-*.sh` + setup류, `tests/`(v1 vitest/shell), 루트 `next.config.mjs`/`tailwind.config.ts`/`postcss.config.mjs`/`.eslintrc.json`/`vitest.config.ts`/루트 `Dockerfile`, `powerpipe/`. `agent/`는 부분 유지(`agent.py`, `agent/lambda/*.py`는 v2 `ai.tf`가 계속 참조 — 삭제 금지). 루트 `package.json`은 `pg`+`@inquirer/prompts`+`@aws-sdk/client-secrets-manager`(명시 추가)로 축소.

```bash
make deps && node scripts/v2/migrate.mjs --status && cd web && npx vitest run
```

## 관련 ADR / Related ADR
- ADR-016 (v1 decommission)
- ADR-011 (multi-account — spoke `AWSopsReadOnlyRole` 보존 근거)
