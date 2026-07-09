# Runbook — v1 레거시 폐기 / v1 Legacy Decommission

ADR-016 실행 절차. v1(단일 EC2 + CloudFront + 공개 ALB, CDK 스택 `AwsopsStack`)을 5단계로 폐기하고 도메인(예: `awsops.atomai.click`, tfvars `domain_name`)을 v2로 컷오버한다. **아래 명령의 리소스 ID는 전부 placeholder다 — 실행 전 조회 명령으로 실제 값을 채운다** (계정 ID·ARN·버킷명 등은 커밋하지 않는 레포 관례).
Procedure for ADR-016. Decommissions v1 in five stages and cuts the domain over to v2. **Every resource ID below is a placeholder** — resolve real values via the lookup commands first (this repo doesn't commit account IDs/ARNs/bucket names).

관련 문서 / Related: `docs/decisions/016-v1-decommission.md`, `docs/history/v1-v2-gap-audit-2026-07-09.md`, `docs/runbooks/v1-to-v2-aurora-backfill.md`.

## 0. 식별자 조회 (매 실행 전 재확인) / Resolve identifiers first

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
V1_EC2_ID=$(aws ec2 describe-instances --filters Name=tag:aws:cloudformation:stack-name,Values=AwsopsStack \
  Name=instance-state-name,Values=running,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
V1_CF_ID=$(aws cloudformation describe-stack-resources --stack-name AwsopsStack \
  --query "StackResources[?ResourceType=='AWS::CloudFront::Distribution'].PhysicalResourceId" --output text)
V1_ALERT_TOPIC_ARN=$(aws sns list-topics --query "Topics[?contains(TopicArn,'awsops-alert-topic')].TopicArn" --output text)
V1_DEPLOY_BUCKET=$(aws s3 ls | awk '{print $3}' | grep '^awsops-deploy-')
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones --query "HostedZones[?Name=='<your-zone>.'].Id" --output text)
```

이후 모든 단계에서 위 변수를 사용한다. 아래 예시의 `<...>` placeholder는 실제 값으로 치환.

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
# 후보가 여러 개면 CreationDate/Name으로 v1 것을 명시적으로 선택 — 자동 단일 매칭 가정하지 않는다
aws cognito-idp list-user-pools --max-results 20 \
  --query "UserPools[?contains(Name,'Awsops') || contains(Name,'AwsopsCognito')].{Id:Id,Name:Name,Created:CreationDate}"
V1_POOL=<위 목록에서 v1 풀 ID 확정>
V2_POOL=$(terraform -chdir=terraform/v2/foundation output -raw cognito_user_pool_id)

aws cognito-idp list-users --user-pool-id "$V1_POOL" --query 'Users[].Username' --output text
aws cognito-idp list-users --user-pool-id "$V2_POOL" --query 'Users[].Username' --output text
```

v2에 없는 사용자는 `aws cognito-idp admin-create-user --user-pool-id "$V2_POOL" --username <email> --user-attributes Name=email,Value=<email>`로 초대(임시 비밀번호 발송, 이관 불가 — 재설정 필요).

### 1.3 alert 경로 외부 발신자 확인 (필수 — ADR-016 §Context)

```bash
# AWS 네이티브 경로 구독자
aws sns list-subscriptions-by-topic --topic-arn "$V1_ALERT_TOPIC_ARN"

# CloudWatch Alarm이 이 토픽을 action으로 쓰는지
aws cloudwatch describe-alarms --query "MetricAlarms[?contains(AlarmActions,\`$V1_ALERT_TOPIC_ARN\`)].AlarmName"
```

사내 Grafana Alerting / Prometheus Alertmanager 설정에서 웹훅 URL이 v1 도메인 또는 v1 ALB DNS를 직접 참조하는지 수동 확인. 발견되면:
- v2 `web/app/api/incidents/webhook/route.ts`로 재설정, 또는
- ADR-016에 "확인 완료, 발신자 없음/재설정 완료"로 기록 후 진행.

**이 확인 없이 Phase 3(EC2 정지)로 넘어가지 않는다.**

---

## Phase 2 — 도메인 컷오버 (Terraform) / Domain cutover

**순서 원칙: create-before-destroy.** v2에 새 별칭을 먼저 붙이고 검증한 뒤, 마지막에 v1에서 별칭을 뗀다 — 그 반대로 하면 v2 apply/Route53 이전이 끝나기 전에 도메인이 붕 뜨는 순단 창이 생긴다.

### 2.1 Terraform 변경 (`terraform/v2/foundation/`)

- `variables.tf`에 `extra_domain_aliases` (list(string), default `[]`) 추가
- `edge.tf`: ACM `subject_alternative_names`(+ 기존 `aws_acm_certificate.cf`에 `lifecycle { create_before_destroy = true }` 확인/추가), CloudFront `aliases`에 `concat`, Route53 레코드 `for_each`화(+ `moved` 블록으로 기존 단일 리소스 주소 보존)
- `auth.tf`: Cognito callback/logout URL에 v1 도메인 추가 (다크 폴백 Hosted UI용)
- tfvars에 `extra_domain_aliases=["<v1-domain>"]`

```bash
terraform -chdir=terraform/v2/foundation plan -out tfplan
# 컨트롤러가 실행 (CloudFront 긴 apply — 서브에이전트 idle-timeout 회피)
terraform -chdir=terraform/v2/foundation apply tfplan
```

이 시점에 v2 CloudFront는 v1 도메인을 별칭으로 갖지만, **Route53은 아직 v1을 가리키고** ACM SAN·CloudFront 쪽만 준비된 상태다. 아직 아무 트래픽도 옮기지 않았으므로 안전하게 검증 가능:

```bash
curl -sI -H "Host: <v1-domain>" https://$(terraform -chdir=terraform/v2/foundation output -raw cloudfront_domain_name) | head -5
```

### 2.2 Route53 레코드를 v2로 전환

기존 A 레코드는 CFN `AwsopsStack` 소유. **CFN 스택에서 이 레코드를 먼저 놓아주지 않으면** Terraform이 같은 이름으로 만들려 할 때 `EntityAlreadyExists` 충돌이 나거나, 반대로 이후 Phase 4에서 CFN이 이 레코드를 삭제해버려 v2 진입점이 끊긴다(§Phase 4 참고). 순서:

```bash
# (a) CFN 스택에서 이 리소스를 보호 대상으로 표시해 두되, 실제 소유권은 import로 TF에 넘긴다
terraform -chdir=terraform/v2/foundation import 'aws_route53_record.alias["<v1-domain>"]' "${HOSTED_ZONE_ID}_<v1-domain>_A"
terraform -chdir=terraform/v2/foundation apply tfplan   # 값이 v2 CloudFront로 갱신됨
```

### 2.3 v1 CloudFront에서 별칭 제거 (마지막)

Route53이 v2를 가리키고 검증(§2.4)까지 마친 **뒤에만** 실행 — 반대 순서면 DNS가 아직 v1을 보는 동안 v1이 그 별칭 요청을 거부하는 순단 창이 생긴다.

```bash
aws cloudfront get-distribution-config --id "$V1_CF_ID" > /tmp/v1-cf-config.json
V1_CF_ETAG=$(jq -r '.ETag' /tmp/v1-cf-config.json)
jq '.DistributionConfig.Aliases.Items -= ["<v1-domain>"] | .DistributionConfig.Aliases.Quantity = (.DistributionConfig.Aliases.Items | length) | .DistributionConfig' \
  /tmp/v1-cf-config.json > /tmp/v1-cf-config-updated.json
aws cloudfront update-distribution --id "$V1_CF_ID" --distribution-config file:///tmp/v1-cf-config-updated.json --if-match "$V1_CF_ETAG"
```

### 2.4 검증

```bash
curl -sI https://<v1-domain> | head -5   # v2 응답(302 → /login) 기대
curl -sI https://<v2-domain> | head -5   # 기존대로 정상
terraform -chdir=terraform/v2/foundation plan     # No changes 기대
```

---

## Phase 3 — v1 다크 (유예 시작) / Go dark (grace period starts)

```bash
aws ec2 stop-instances --instance-ids "$V1_EC2_ID"

aws cloudfront get-distribution-config --id "$V1_CF_ID" > /tmp/v1-cf-disable.json
V1_CF_ETAG2=$(jq -r '.ETag' /tmp/v1-cf-disable.json)
jq '.DistributionConfig.Enabled = false | .DistributionConfig' /tmp/v1-cf-disable.json > /tmp/v1-cf-disable-updated.json
aws cloudfront update-distribution --id "$V1_CF_ID" --distribution-config file:///tmp/v1-cf-disable-updated.json --if-match "$V1_CF_ETAG2"
```

유예 1~2주 관찰. 문제 발생 시 **롤백**:

```bash
aws ec2 start-instances --instance-ids "$V1_EC2_ID"
# CloudFront Enabled=true로 되돌리고, 필요 시에만 §2.3의 역순으로 별칭을 v1에 임시 복원
```

---

## Phase 4 — 완전 삭제 (유예 후) / Full teardown (after grace period)

```bash
# 4.1 스택 전수 확인
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'Awsops')].StackName"

# 4.2 Lambda@Edge 선처리 — us-east-1, distribution 연결 해제 후 replica 소멸 대기(수 시간)
aws lambda get-function --function-name awsops-cognito-auth --region us-east-1

# 4.3 CDK 스택 삭제 — DomainARecord는 **항상 retain** (Phase 2.2에서 이미 Terraform 소유로 넘어갔으므로
#     CFN이 삭제를 시도하면 v2의 유일한 진입점이 끊긴다 — "충돌 시"가 아니라 매번 필수)
aws cloudformation delete-stack --stack-name AwsopsStack --retain-resources DomainARecord
aws cloudformation wait stack-delete-complete --stack-name AwsopsStack
# 삭제 후 Route53/TF state에 drift 없는지 확인:
terraform -chdir=terraform/v2/foundation plan   # DomainARecord 관련 변경 없어야 함

# 4.4 고아 리소스 개별 삭제 (CFN 스택 밖 — 이름은 사전 조사 시점 기준, 실행 전 list-functions로 재확인)
aws lambda list-functions --query "Functions[?starts_with(FunctionName,'awsops-') && !starts_with(FunctionName,'awsops-v2-')].FunctionName" --output text | \
  tr '\t' '\n' | while read -r fn; do aws lambda delete-function --function-name "$fn"; done
aws s3 rm "s3://${V1_DEPLOY_BUCKET}" --recursive && aws s3api delete-bucket --bucket "${V1_DEPLOY_BUCKET}"
```

**절대 삭제하지 않는 것**: v2 apply 이후에도 다른 서비스가 쓰는 공유 VPC/NLB, 공유 hosted zone, `CDKToolkit`, spoke 계정의 cross-account 조회 롤(v2가 계속 사용), 외부 docs 사이트 DNS 레코드, `awsops-v2-*` 전체.

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
- ADR-011 (multi-account — spoke cross-account role 보존 근거)
