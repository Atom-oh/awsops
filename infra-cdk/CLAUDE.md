# CDK 인프라 / CDK Infrastructure

## 역할 / Role
AWS 인프라 전체를 Code로 정의. VPC·EC2·ALB·CloudFront·Cognito·Lambda@Edge·AgentCore 관련 IAM/ECR을 3개 스택으로 분리.
(All AWS infrastructure as code, split across three stacks: core app, Cognito auth, AgentCore scaffolding.)

## 스택 / Stacks
| 스택 | 파일 | 내용 |
|------|------|------|
| `AwsopsStack` | `lib/awsops-stack.ts` | VPC(3-AZ), EC2 t4g.2xlarge(ARM64, Private), ALB(CloudFront-only SG), CloudFront(CACHING_DISABLED), SSM VPC Endpoints, IAM 인스턴스 프로파일 |
| `CognitoStack` | `lib/cognito-stack.ts` | Cognito User Pool, App Client, Hosted UI Domain, Lambda@Edge(Python 3.12, us-east-1) viewer-request 인증 |
| `AgentCoreStack` | `lib/agentcore-stack.ts` | AgentCore Runtime/Gateway용 IAM 역할, ECR 리포지토리, 보조 리소스 (실제 Runtime/Gateway 생성은 `scripts/06*`가 담당) |

## 배포 / Deploy
```bash
# 로컬에서 실행 (EC2 아님)
cd infra-cdk
npm install
npx cdk bootstrap            # 최초 1회 per account/region
npx cdk deploy AwsopsStack
npx cdk deploy CognitoStack  # us-east-1 리전 (Lambda@Edge 요구사항)
npx cdk deploy AgentCoreStack
```

또는 `scripts/00-deploy-infra.sh`/`00-update-infra.sh` 래퍼 사용.
(Or use the wrapper scripts `scripts/00-deploy-infra.sh` / `00-update-infra.sh`.)

## 주요 파일 / Key Files
- `bin/*.ts` — CDK App 엔트리
- `cdk.json` — 컨텍스트 (account ID, 리전)
- `cdk.context.json` — 자동 생성, 계정 종속 (gitignored)
- `cfn-target-account-role.yaml` — 멀티 어카운트용 교차 계정 IAM 역할 CloudFormation 템플릿 (Host 계정이 Target 계정을 쿼리할 때 사용)
- `package.json` — `aws-cdk-lib`, `constructs`
- `README.md` — 배포 절차 상세

## 규칙 / Rules
- CloudFront Lambda@Edge는 **us-east-1**에서만 배포 — CognitoStack의 `env.region` 고정
- 모든 컴퓨트는 **ARM64 (Graviton)** — t4g.2xlarge + Docker `--platform linux/arm64`
- ALB 보안 그룹은 CloudFront prefix list(`com.amazonaws.global.cloudfront.origin-facing`)만 허용 — 인바운드 포트 80-3000
- EC2는 Private Subnet 고정 — SSM Session Manager로만 접근 (public IP 없음)
- CachePolicy는 **CACHING_DISABLED** — AWS 실시간 데이터를 캐싱하지 않음
- `cdk.context.json`은 커밋 금지 (gitignored) — 계정 부트스트랩마다 자동 생성
- `cdk deploy --require-approval never` 사용 금지 — IAM/SG 변경은 수동 승인

---

# CDK Infrastructure (English summary)

Three stacks define all AWS infra:
- **AwsopsStack** — VPC, EC2 (ARM64, Private), ALB (CF-only), CloudFront (no caching), SSM endpoints.
- **CognitoStack** — User Pool, App Client, Hosted UI Domain, Lambda@Edge (Python 3.12, us-east-1 only).
- **AgentCoreStack** — IAM roles + ECR repos for AgentCore; actual Runtime/Gateway creation happens in `scripts/06*`.

Rules:
- Lambda@Edge deploys only in `us-east-1`.
- All compute is ARM64 (Graviton); Docker must use `--platform linux/arm64`.
- ALB SG permits only the CloudFront prefix list on ports 80-3000.
- EC2 runs in a Private Subnet; access via SSM only.
- CloudFront uses `CACHING_DISABLED` since AWS data is real-time.
- Do not commit `cdk.context.json`.
- Never pass `--require-approval never`; IAM/SG changes require manual review.
