# ADR-024: CDK Three-Stack Split (Awsops / Cognito / AgentCore)

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops infrastructure combines a large Next.js application host (VPC, EC2, ALB, CloudFront), a Cognito-based authentication layer backed by Lambda@Edge, and a Bedrock AgentCore scaffolding layer (IAM roles and an ECR repository that seed the imperative `scripts/06*` rollout). These three concerns have divergent regional, lifecycle, and API maturity constraints, and attempting to colocate them in a single CloudFormation stack would be fragile on every axis — region pinning, blast radius, and drift visibility.

AWSops 인프라는 대규모 Next.js 앱 호스트(VPC·EC2·ALB·CloudFront), Lambda@Edge 기반 Cognito 인증 계층, 그리고 `scripts/06*`로 이어지는 Bedrock AgentCore 스캐폴딩(IAM 역할·ECR 리포지토리)을 함께 포함한다. 세 영역은 리전, 수명 주기, API 성숙도 측면에서 제약이 달라 하나의 CloudFormation 스택으로 합치면 리전 고정, 장애 전파, 드리프트 가시성 모든 측면에서 취약해진다.

The concrete trigger is Lambda@Edge: CloudFront viewer-request functions can only be created from `us-east-1`. The primary application region is typically `ap-northeast-2`. CDK stacks bind to a single `env.region`, and cross-region references require the `crossRegionReferences: true` flag plus SSM-parameter plumbing. Additionally, AgentCore Runtime/Gateway have no stable CloudFormation resource types today, so even if we wanted "one stack," the AgentCore parts would still bleed out into imperative scripts.

구체적 계기는 Lambda@Edge이다. CloudFront viewer-request 함수는 `us-east-1`에서만 생성 가능하나 앱의 주 리전은 보통 `ap-northeast-2`이다. CDK 스택은 단일 `env.region`에 바인딩되며 교차 리전 참조는 `crossRegionReferences: true` 플래그와 SSM 파라미터 배선이 필요하다. 또한 AgentCore Runtime/Gateway는 안정적인 CloudFormation 리소스 타입이 없어, 한 스택으로 묶어도 결국 명령형 스크립트로 새어 나간다.

## Options Considered / 고려한 대안

### Option 1: Three-stack split (Awsops / Cognito / AgentCore) — chosen / 3-스택 분리 — 채택

`AwsopsStack` owns VPC/EC2/ALB/CloudFront/SSM endpoints in the primary region. `CognitoStack` owns the User Pool, Hosted UI domain, and Lambda@Edge, pinned to `us-east-1`. `AgentCoreStack` owns the (currently placeholder) IAM/ECR substrate for AgentCore, in the primary region. Each stack owns its failure domain; cross-stack wiring is limited to the CloudFront distribution reference passed from Awsops into Cognito via `crossRegionReferences`.

`AwsopsStack`은 주 리전의 VPC·EC2·ALB·CloudFront·SSM Endpoint를 소유하고, `CognitoStack`은 User Pool·Hosted UI·Lambda@Edge를 `us-east-1`에 고정하여 소유하며, `AgentCoreStack`은 AgentCore용 IAM/ECR 기반을 주 리전에 (현재는 플레이스홀더로) 소유한다. 각 스택이 자신의 장애 도메인을 갖고, 스택 간 배선은 `crossRegionReferences`로 Awsops → Cognito에 전달되는 CloudFront Distribution 참조만으로 제한된다.

### Option 2: Single monolithic stack / 단일 통합 스택

All resources in one `AwsopsStack`. Rejected because (a) CloudFormation's 500-resource soft limit is easy to hit with VPC + ALB + CloudFront + Cognito + Lambda@Edge + AgentCore IAM in one template, (b) the stack cannot span `ap-northeast-2` and `us-east-1` without awkward nested stacks, and (c) a Cognito or AgentCore rollback would tear down CloudFront and the EC2 instance, creating unnecessary blast radius for unrelated changes.

모든 리소스를 하나의 `AwsopsStack`에 담는 안. (a) VPC·ALB·CloudFront·Cognito·Lambda@Edge·AgentCore IAM을 한 템플릿에 담으면 CloudFormation 500 리소스 소프트 리밋에 근접하고, (b) `ap-northeast-2`와 `us-east-1` 두 리전을 동시에 다루려면 중첩 스택이 필요하며, (c) Cognito/AgentCore 롤백이 CloudFront와 EC2까지 함께 되감아 무관한 변경에도 과도한 장애 반경을 만든다.

### Option 3: Many fine-grained stacks (VPC / EC2 / ALB / CloudFront / Cognito / …) / 세분화된 다수 스택

One stack per service. Rejected because the coupling between VPC, ALB, EC2, and CloudFront is so tight that splitting them yields only ceremony — cross-stack `Fn::ImportValue` references, ordering constraints, and CDK context churn — with no operational benefit. The true fault lines are region and maturity, not service boundary.

서비스별로 스택을 쪼개는 안. VPC·ALB·EC2·CloudFront 사이 결합이 워낙 강해 분리해도 `Fn::ImportValue`와 순서 제약, CDK 컨텍스트 변동만 늘 뿐 운영적 이점이 없다. 실제 단층선은 서비스 경계가 아니라 리전과 API 성숙도이다.

## Decision / 결정

Adopt the three-stack split with the stack responsibilities below, matching `infra-cdk/bin/app.ts`:

아래 표대로 3-스택 분리를 채택한다. `infra-cdk/bin/app.ts`의 현재 구조와 일치한다:

| Stack | File | Region | Scope |
|-------|------|--------|-------|
| `AwsopsStack` | `infra-cdk/lib/awsops-stack.ts` | `CDK_DEFAULT_REGION` (기본 `ap-northeast-2`) | VPC, EC2, ALB, CloudFront, SSM Endpoints, EC2 IAM role, alert SNS/SQS |
| `AwsopsCognitoStack` | `infra-cdk/lib/cognito-stack.ts` | `us-east-1` (hard-coded) | User Pool, App Client, Hosted UI Domain, Lambda@Edge |
| `AwsopsAgentCoreStack` | `infra-cdk/lib/agentcore-stack.ts` | primary region | Placeholder for AgentCore IAM/ECR; actual Runtime/Gateway via `scripts/06*` |

```typescript
// infra-cdk/bin/app.ts — stack wiring
const cognito = new CognitoStack(app, 'AwsopsCognitoStack', {
  env: { account: env.account, region: 'us-east-1' }, // Lambda@Edge must be in us-east-1
  crossRegionReferences: true,
  distribution: infra.distribution,
});
cognito.addDependency(infra);
```

Actual AgentCore Runtime, 8 Gateways, 19 Lambdas, Code Interpreter, and Memory Store are created by `scripts/06a-06f` using boto3/CLI rather than CDK — see ADR-004 (Gateway role split) and ADR-015 (FinOps MCP Lambda). Lambda@Edge is attached to the CloudFront distribution in Step 8 (`08-setup-cloudfront-auth.sh`), not by CDK.

실제 AgentCore Runtime, 8개 Gateway, 19개 Lambda, Code Interpreter, Memory Store는 CDK가 아닌 `scripts/06a-06f`가 boto3/CLI로 생성한다 — ADR-004(Gateway 역할 분리), ADR-015(FinOps MCP Lambda) 참조. Lambda@Edge의 CloudFront 연결은 CDK가 아니라 Step 8 (`08-setup-cloudfront-auth.sh`)가 담당한다.

## Rationale / 근거

The split localizes region pinning: only `CognitoStack` carries the `us-east-1` constraint, so `AwsopsStack` can move between regions (Seoul, Tokyo, Singapore, ...) without conditional CDK logic. Blast radius is also bounded — a Cognito misconfiguration cannot roll back the EC2 host or the CloudFront distribution, and an AgentCore IAM change will never touch the application path. Because AgentCore Runtime/Gateway APIs are newer than stable CDK L2 constructs, keeping the stack as a thin IAM/ECR substrate and delegating the imperative parts to shell scripts lets operators keep pace with new Bedrock AgentCore APIs without writing custom resources.

이 분리는 리전 고정을 국지화한다. `CognitoStack`만 `us-east-1` 제약을 지니므로 `AwsopsStack`은 조건부 CDK 로직 없이 서울·도쿄·싱가포르 등 리전을 자유롭게 이동할 수 있다. 장애 반경도 한정된다. Cognito 오설정이 EC2 호스트나 CloudFront를 되감지 않고, AgentCore IAM 변경이 앱 경로에 닿지 않는다. AgentCore Runtime/Gateway API는 안정된 CDK L2 구성보다 신형이므로, 스택을 얇은 IAM/ECR 기반으로 두고 명령형 부분은 셸 스크립트에 맡기면 커스텀 리소스 없이 새 Bedrock AgentCore API를 따라갈 수 있다.

Config hygiene also motivates the split. `cdk.context.json` encodes account-specific AZ metadata and VPC lookups and is `.gitignored`; each bootstrapped account regenerates it. `cdk.json` (the CDK feature flags and app command) is tracked. `cdk.out/` — the synthesized CloudFormation templates — is `.gitignored` because it is a build artifact. With three stacks the context surface for any one deployment is small and inspectable.

설정 위생 측면의 이점도 있다. `cdk.context.json`은 계정별 AZ 메타데이터와 VPC 조회 결과를 담고 있어 `.gitignored`로 관리되며 부트스트랩마다 재생성된다. `cdk.json`(CDK 피처 플래그·앱 명령)은 추적된다. `cdk.out/`는 합성된 CloudFormation 템플릿으로 빌드 산출물이라 `.gitignored`이다. 3-스택 구조에서는 각 배포가 다루는 컨텍스트 표면적이 작고 검토 가능하다.

## Consequences / 결과

### Positive / 긍정적

- Region constraint isolation: only `CognitoStack` is locked to `us-east-1`; the other two follow `CDK_DEFAULT_REGION`.
- Independent updates: AgentCore scaffolding redeploys without touching Cognito or the app host.
- Bounded blast radius: a failed Cognito deploy does not roll back EC2/CloudFront; AgentCore drift is invisible to the web tier.
- Script-based AgentCore creation keeps pace with new AWS AgentCore APIs without custom resources.
- Cross-region wiring stays minimal — one `crossRegionReferences` edge from Awsops to Cognito.

- 리전 제약 국지화: `CognitoStack`만 `us-east-1`에 고정되고 나머지는 `CDK_DEFAULT_REGION`을 따른다.
- 독립 업데이트: AgentCore 기반을 Cognito나 앱 호스트 무관하게 재배포할 수 있다.
- 제한된 장애 반경: Cognito 배포 실패가 EC2/CloudFront를 되감지 않고 AgentCore 드리프트는 웹 계층에 보이지 않는다.
- 스크립트 기반 AgentCore 생성으로 신규 AgentCore API에 커스텀 리소스 없이 대응한다.
- 교차 리전 배선이 최소화된다 — Awsops → Cognito 간 `crossRegionReferences` 하나뿐.

### Negative / 부정적

- Deployment order is mandatory: `AwsopsStack` (primary region) → `AwsopsCognitoStack` (`us-east-1`) → `AwsopsAgentCoreStack` → `scripts/05/06*/08`. Operators must remember the region switch for Cognito.
- Cross-stack wiring (CloudFront distribution id → Lambda@Edge association) is completed by Step 8 (`08-setup-cloudfront-auth.sh`), not CDK — `cdk diff` does not reflect the Lambda@Edge attachment.
- `cdk diff` cannot show AgentCore Runtime/Gateway drift because those resources live outside CDK. Operators must inspect `data/config.json` and the AgentCore console for drift.
- Three stacks mean three `cdk.context.json` inputs to understand when onboarding a new account, plus three CloudFormation stacks to observe during incidents.

- 배포 순서 강제: `AwsopsStack` (주 리전) → `AwsopsCognitoStack` (`us-east-1`) → `AwsopsAgentCoreStack` → `scripts/05/06*/08`. Cognito 리전 전환을 반드시 기억해야 한다.
- 스택 간 배선(CloudFront Distribution ID → Lambda@Edge 결합)은 CDK가 아닌 Step 8 (`08-setup-cloudfront-auth.sh`)에서 완성되므로 `cdk diff`에 Lambda@Edge 연결이 반영되지 않는다.
- AgentCore Runtime/Gateway는 CDK 밖에 있어 `cdk diff`가 드리프트를 보여주지 못한다. 드리프트 확인은 `data/config.json`과 AgentCore 콘솔에서 직접 해야 한다.
- 새 계정 온보딩 시 세 개의 `cdk.context.json` 입력을 이해해야 하고, 장애 시 관찰해야 할 CloudFormation 스택이 셋이 된다.

## References / 참고

- `infra-cdk/lib/awsops-stack.ts` — primary-region app stack (VPC, EC2, ALB, CloudFront, SSM, alert SQS/SNS).
- `infra-cdk/lib/cognito-stack.ts` — `us-east-1` Cognito + Lambda@Edge stack.
- `infra-cdk/lib/agentcore-stack.ts` — AgentCore IAM/ECR substrate (placeholder; `scripts/06*` owns Runtime/Gateway).
- `infra-cdk/bin/app.ts` — stack wiring and `crossRegionReferences`.
- `infra-cdk/CLAUDE.md` — stack responsibilities and deployment rules.
- `scripts/00-deploy-infra.sh`, `scripts/00-update-infra.sh` — CDK deploy/update wrappers.
- ADR-004 — Gateway role split (why AgentCore Gateways are script-managed).
- ADR-015 — FinOps MCP Lambda (AgentCore Lambda lifecycle).
- ADR-020 — Cognito authentication flow (consumer of `CognitoStack`).
