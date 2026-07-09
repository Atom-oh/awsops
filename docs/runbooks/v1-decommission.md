# Runbook — v1 레거시 폐기 / v1 Legacy Decommission

ADR-016 실행 절차 — Phase 0(문서 게이트, 완료)에 이어지는 실행 Phase 1~5. v1(단일 EC2 + CloudFront + 공개 ALB, CDK 스택 `AwsopsStack`)을 도메인(예: `awsops.atomai.click`, tfvars `domain_name`)을 v2로 컷오버하며 단계적으로 폐기한다. **아래 명령의 리소스 ID는 전부 placeholder다 — 실행 전 조회 명령으로 실제 값을 채운다** (계정 ID·ARN·버킷명 등은 커밋하지 않는 레포 관례).
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
aws s3 ls | awk '{print $3}' | grep '^awsops-deploy-'   # 후보가 여러 개면 아래를 단일 값으로 직접 확정 — 자동 단일매칭 가정 금지
V1_DEPLOY_BUCKET=<위 목록에서 확정한 단일 버킷명>
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
- v2 `web/app/api/incidents/webhook/route.ts`로 재설정 — **단, 이 라우트는 `INCIDENT_LIFECYCLE_ENABLED !== 'true'`면 503을 반환한다**(`route.ts:129`). 재설정 전에 해당 flag가 `true`이고 HMAC 시크릿이 SSM에 구성되어 있는지 먼저 확인/활성화한다. 그 전제조건 없이 발신자만 옮기면 여전히 무음 유실(404 대신 503). 추가로 `incident_lifecycle_enabled`는 `workers_enabled=true`를 하드 전제로 요구한다(`variables.tf:150`) — 이것 없이 켜면 plan 단계에서 index 오류.
- 또는 ADR-016에 "확인 완료, 발신자 없음/재설정 완료"로 기록 후 진행.

**이 확인 없이 Phase 3(EC2 정지)로 넘어가지 않는다.**

---

## Phase 2 — 도메인 컷오버 (Terraform) / Domain cutover

**CloudFront는 동일 별칭(CNAME)을 두 distribution에 동시 등록할 수 없다** — v2에 별칭을 추가하는 일반 `UpdateDistribution`을, v1이 아직 그 별칭을 갖고 있는 동안 실행하면 `CNAMEAlreadyExists`로 즉시 실패한다. 같은 계정 내 이동에는 전용 원자적 명령 `aws cloudfront associate-alias`를 쓴다.

`edge.tf`의 `aws_route53_record.alias`(현재 **singleton**, `for_each` 아님 — line ~124)를 그대로 두고 v1 도메인 키를 바로 import하면 "resource address does not exist in configuration"으로 실패한다. **순서가 중요하다**: ① cert SAN만 먼저 → ② 기존 v2 레코드를 `moved` 블록으로 singleton→for_each(v2 도메인만) 전환·apply(순수 state 정리, 실제 변경 없음) → ③ associate-alias 원자 이동 → ④ v1 CFN에서 레코드 소유권 해제 → ⑤ for_each에 v1 도메인 추가 + import + 새 plan/apply. **각 단계에서 실제로 발생 가능한 짧은 순단을 명시적으로 인지하고, ③~⑤는 가능한 한 연속으로 수행한다** — associate-alias 직후부터 Route53이 v2를 가리키기 전까지는 v1 CloudFront가 이 Host를 더는 인식하지 못해 오류를 낼 수 있으므로 이건 "무중단"이 아니라 "짧은 순단 가능 + 최소화" 절차다.

### 2.1 ACM SAN만 먼저 적용 (별칭·레코드는 아직 안 건드림)

```bash
# variables.tf: extra_domain_aliases (list(string), default []) 추가
# edge.tf: aws_acm_certificate.cf에 subject_alternative_names = var.extra_domain_aliases 추가
#          (create_before_destroy는 이미 설정되어 있음)
# tfvars: extra_domain_aliases=["<v1-domain>"]  ← 지금은 cert SAN 용도로만 참조
terraform -chdir=terraform/v2/foundation plan -out tfplan
terraform -chdir=terraform/v2/foundation apply tfplan   # ACM 발급·검증만, CloudFront/Route53 변경 없음
```

### 2.2 기존 v2 레코드를 `moved` 블록으로 for_each 전환 (v1 도메인은 아직 미포함)

`moved` 블록의 `from`/`to`는 **정적(static) 주소만 허용** — 인스턴스 키에 `${var.domain_name}` 같은 변수 보간을 쓰면 config 파싱 단계에서 실패한다. 리터럴 문자열로 쓴다(실제 도메인 값으로 치환):

```hcl
# edge.tf: aws_route53_record.alias를 for_each = toset([var.domain_name])로 먼저 바꾼다 (v1 도메인 아직 X)
moved {
  from = aws_route53_record.alias
  to   = aws_route53_record.alias["<v2-domain-literal>"]   # 예: "awsops-v2.atomai.click" — 변수 보간 금지, 리터럴만
}
```

```bash
terraform -chdir=terraform/v2/foundation plan -out tfplan   # "0 to add, 0 to destroy" — 순수 리매핑이어야 함
terraform -chdir=terraform/v2/foundation apply tfplan
```

대안(`moved` 블록 없이 즉시 처리): `terraform state mv 'aws_route53_record.alias' 'aws_route53_record.alias["<v2-domain-literal>"]'`

여기까지는 실제 인프라 변경이 전혀 없다 — 나중에 v1 도메인을 위험 없이 끼워 넣기 위한 사전 정지작업.

### 2.3 `associate-alias`로 원자적 이동

```bash
V2_CF_ID=$(terraform -chdir=terraform/v2/foundation output -raw distribution_id)
aws cloudfront associate-alias --target-distribution-id "$V2_CF_ID" --alias "<v1-domain>"
```

CloudFront 레벨에서 별칭이 v1→v2로 원자 이동한다. **Route53은 아직 v1을 가리키므로, DNS가 v1 CloudFront로 트래픽을 보내는 동안 v1은 이제 이 Host를 인식하지 못해 오류(403류)를 낼 수 있다 — 바로 §2.4~2.5로 이어서 멈추지 않고 끝낸다.**

### 2.4 Route53 레코드 소유권을 v1 CFN에서 풀어준다

`terraform import`는 TF state에 리소스를 편입할 뿐 CFN `AwsopsStack`의 소유권을 제거하지 않는다 — 그대로 두면 두 IaC가 같은 레코드를 관리하게 되고, Phase 4에서 CFN이 삭제를 시도해 v2 진입점이 끊길 수 있다. **CFN 쪽에서 먼저 놓아준다**(`infra-cdk/lib/awsops-stack.ts`의 `DomainARecord` 구성):

```bash
# (a) 해당 record 구성에서 (route53.ARecord L2 construct의 생성자 props가 아니라)
#     record.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN) 호출 추가 후 배포 (CFN엔 남지만 스택 삭제 시 삭제 안 되도록 마킹)
cd infra-cdk && npx cdk deploy AwsopsStack
# (b) 템플릿에서 DomainARecord 리소스 자체를 제거하고 다시 배포 — RETAIN 덕분에 실제 Route53 레코드는 남고 CFN 관리에서만 빠진다
npx cdk deploy AwsopsStack
cd ..
```

### 2.5 for_each에 v1 도메인 추가 + import + 새 plan/apply

**먼저 config을 바꾼다**(import는 config에 그 주소가 선언되어 있어야 함): `edge.tf`의 `for_each`를 `toset(concat([var.domain_name], var.extra_domain_aliases))`로, CloudFront `aliases`도 동일하게 `concat`으로 확장. `auth.tf`의 Cognito callback/logout URL에도 v1 도메인 추가(다크 폴백 Hosted UI용).

```bash
ZONE_ID_BARE=$(echo "$HOSTED_ZONE_ID" | sed 's#/hostedzone/##')   # list-hosted-zones의 Id는 "/hostedzone/Z..." 형태
terraform -chdir=terraform/v2/foundation import 'aws_route53_record.alias["<v1-domain>"]' "${ZONE_ID_BARE}_<v1-domain>_A"

# import 직후 이전 plan(tfplan)은 stale — 반드시 새로 생성
terraform -chdir=terraform/v2/foundation plan -out tfplan2
terraform -chdir=terraform/v2/foundation apply tfplan2
```

§2.3에서 CloudFront 별칭은 이미 실제로 바뀌어 있으므로 그 부분은 reconcile(무변경)이고, 이 apply의 실질 효과는 **Route53 레코드의 alias target을 v1→v2 distribution domain으로 갱신**하는 것이다 — 이 apply가 끝나야 DNS 레벨에서도 완전히 v2로 넘어간다.

### 2.6 검증

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

# CloudFront를 다시 Enabled=true로 (forward의 disable 블록과 대칭)
aws cloudfront get-distribution-config --id "$V1_CF_ID" > /tmp/v1-cf-enable.json
V1_CF_ETAG3=$(jq -r '.ETag' /tmp/v1-cf-enable.json)
jq '.DistributionConfig.Enabled = true | .DistributionConfig' /tmp/v1-cf-enable.json > /tmp/v1-cf-enable-updated.json
aws cloudfront update-distribution --id "$V1_CF_ID" --distribution-config file:///tmp/v1-cf-enable-updated.json --if-match "$V1_CF_ETAG3"

# 별칭을 v1으로 역이동 (associate-alias는 대상 distribution의 alias만 바꾼다 —
# Route53 레코드는 별개로 반드시 같이 되돌려야 한다. 둘 중 하나만 하면 "별칭은 v1인데 DNS는 v2"류 엇갈림으로
# 동일한 403이 반대 방향으로 재발한다):
aws cloudfront associate-alias --target-distribution-id "$V1_CF_ID" --alias "<v1-domain>"
# Route53 alias target을 v1 distribution domain으로 원복 (v2 apply로 넘어가기 전 임시 조치이므로 TF state는 그대로 두고
# out-of-band로 API를 직접 되돌린 뒤, 안정화되면 Phase 2를 재검토해 TF 쪽도 맞춘다):
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID_BARE" --change-batch '{
  "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
    "Name": "<v1-domain>", "Type": "A",
    "AliasTarget": {"HostedZoneId": "Z2FDTNDATAQYW2", "DNSName": "<v1-cloudfront-domain>.cloudfront.net", "EvaluateTargetHealth": false}
  }}]
}'
```

---

## Phase 4 — 완전 삭제 (유예 후) / Full teardown (after grace period)

```bash
# 4.1 스택 전수 확인
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'Awsops')].StackName"

# 4.2 Lambda@Edge 선처리 — **반드시 --region us-east-1** (Lambda@Edge는 이 리전에서만 관리된다.
#     4.4의 고아 Lambda 조회는 기본 리전(ap-northeast-2 등)이므로 이 함수는 그 목록에 안 잡힌다 — 별도 처리)
aws lambda get-function --function-name awsops-cognito-auth --region us-east-1
# distribution 연결 해제(모든 CloudFront behavior에서 이 함수 associate 제거) 후 replica 소멸까지 수 시간 대기,
# 그 다음에만: aws lambda delete-function --function-name awsops-cognito-auth --region us-east-1

# 4.3 CDK 스택 삭제
# §2.4를 이미 수행했다면(정상 경로) DomainARecord는 템플릿에서 제거되어 CFN 관리 밖이므로 --retain-resources 불필요/무의미:
aws cloudformation delete-stack --stack-name AwsopsStack
# §2.4를 건너뛴 예외 경로라면(레코드가 아직 CFN 템플릿에 남아있는 경우에만) 대신 이 명령을 쓴다:
#   aws cloudformation delete-stack --stack-name AwsopsStack --retain-resources DomainARecord
aws cloudformation wait stack-delete-complete --stack-name AwsopsStack
# 삭제 후 Route53/TF state에 drift 없는지 확인:
terraform -chdir=terraform/v2/foundation plan   # DomainARecord 관련 변경 없어야 함

# 4.4 고아 리소스 개별 삭제 — blast radius 주의: "awsops-" prefix 매칭은 v1과 무관한 다른 Lambda까지 휩쓸 수 있다.
#     반드시 (a) 먼저 dry-run으로 목록만 뽑아 사람이 검토 → (b) ADR-016/gap-audit 조사 시점 목록과 대조 → (c) 그 다음 삭제.
aws lambda list-functions --query "Functions[?starts_with(FunctionName,'awsops-') && !starts_with(FunctionName,'awsops-v2-')].{Name:FunctionName,Runtime:Runtime,Modified:LastModified}"
# ↑ 이 출력을 육안 검토: v1 조사 시점(2026-07-08) 기준 py3.12 runtime의 *-mcp 슬라이스 18개 + steampipe-query 여야 한다.
#   목록이 다르면(다른 py 버전/최근 수정/모르는 이름) 그 함수는 제외하고 개별 확인한다.
CONFIRMED_ORPHAN_LAMBDAS=(<검토 완료 후 (a)~(b)에서 확정된 함수명만 여기 나열>)
for fn in "${CONFIRMED_ORPHAN_LAMBDAS[@]}"; do aws lambda delete-function --function-name "$fn"; done

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
make deps && node scripts/v2/migrate.mjs --status
cd web && npx vitest run && npm run build && cd ..
terraform -chdir=terraform/v2/foundation validate && terraform -chdir=terraform/v2/foundation plan   # No changes 기대
```

## 관련 ADR / Related ADR
- ADR-016 (v1 decommission)
- ADR-011 (multi-account — spoke cross-account role 보존 근거)
