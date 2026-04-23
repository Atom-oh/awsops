# 배포 스크립트 / Deployment Scripts

## 역할 / Role
EC2 인스턴스에서 AWSops 스택을 설치·구성·운영하는 11단계 스크립트. 최초 배포는 00→01→02→03→05→06a~f→07→08→09 순. 재시작은 10→09.
(Step-by-step scripts for installing and operating the AWSops stack on EC2. First deploy: 00→01→02→03→05→06a-f→07→08→09. Restart: 10→09.)

## 스텝 매트릭스 / Step Matrix
| Step | 스크립트 | 역할 | 실행 위치 |
|------|----------|------|-----------|
| 0 | `00-deploy-infra.sh` / `00-update-infra.sh` | CDK 인프라 배포/업데이트 (VPC·EC2·ALB·CloudFront) | **로컬** |
| 1 | `01-install-base.sh` | Steampipe + Powerpipe 설치 + AWS/K8s/Trivy 플러그인 | EC2 |
| 2 | `02-setup-nextjs.sh` | Node.js + Next.js + Steampipe systemd 서비스 + MSP 자동 감지 | EC2 |
| 3 | `03-build-deploy.sh` | 프로덕션 빌드 (`npm run build`) + systemd 서비스 등록 | EC2 |
| 4 | `04-setup-eks-access.sh` | EKS Access Entry + kubeconfig | EC2 |
| 5 | `05-setup-cognito.sh` | Cognito User Pool 부트스트랩 + Lambda@Edge 등록 | 로컬(us-east-1) |
| 6a | `06a-setup-agentcore-runtime.sh` | IAM 역할, ECR, Docker arm64 빌드, Runtime, Endpoint 생성 | EC2 |
| 6b | `06b-setup-agentcore-gateway.sh` | 8개 Gateway (Network/Container/IaC/Data/Security/Monitoring/Cost/Ops) | EC2 |
| 6c | `06c-setup-agentcore-tools.sh` | 19개 Lambda + `create_targets.py` → 125 MCP 도구 연결 | EC2 |
| 6d | `06d-setup-agentcore-interpreter.sh` | Code Interpreter (Python sandbox) | EC2 |
| 6e | `06e-setup-agentcore-config.sh` | `data/config.json`에 ARN/Gateway URL 주입 | EC2 |
| 6f | `06f-setup-agentcore-memory.sh` | Memory Store (365일 대화 이력) | EC2 |
| 7 | `07-setup-opencost.sh` (+`-interactive`) | Prometheus + OpenCost (EKS 비용 분석) | EC2 |
| 8 | `08-setup-cloudfront-auth.sh` | Lambda@Edge → CloudFront 연동 | 로컬(us-east-1) |
| 9 | `09-start-all.sh` | 전체 서비스 시작 (steampipe, nextjs, alert-poller) | EC2 |
| 10 | `10-stop-all.sh` | 전체 서비스 중지 | EC2 |
| 11 | `11-verify.sh` | 헬스체크 (포트, 쿼리, Gateway 응답) | EC2 |
| 12 | `12-setup-multi-account.sh` | Target 계정 IAM 역할 생성 + Aggregator 추가 (선택) | 로컬+EC2 |

`setup.sh`/`install-all.sh` — 위 스텝들을 순차 실행하는 래퍼.
`06-setup-agentcore.sh` — 과거 단일 스크립트(deprecated). 6a~f로 쪼개짐.
`setup-cognito-ui.sh` — Cognito Hosted UI 커스터마이징.
`test-ai-routes.py` — AI 라우터 smoke 테스트.
`ARCHITECTURE.md` — 스텝별 상세 다이어그램.

## 규칙 / Rules
- 모든 스크립트는 `set -euo pipefail` — 실패 시 즉시 중단
- EC2 스크립트는 `ec2-user` HOME 기준 상대 경로 — `cd "$(dirname "$0")/.."`로 프로젝트 루트 이동
- Docker 빌드는 반드시 arm64 — `docker buildx --platform linux/arm64 --load`
- 민감 값은 스크립트 입력(read 또는 인자) — 하드코딩 금지
- AgentCore Runtime 업데이트 시 `--role-arn` + `--network-configuration` 필수
- Code Interpreter / Memory 이름은 언더스코어만 (하이픈 금지)
- Cognito / Lambda@Edge 관련은 **us-east-1** 고정
- 새 스텝 추가 시 번호 체계 유지 + `ARCHITECTURE.md`와 CLAUDE.md 업데이트

---

# Deployment Scripts (English summary)

Sequence: 00 → 01 → 02 → 03 → 05 → 06a-f → 07 → 08 → 09. Step 0, 5, 8 run locally (CDK + us-east-1 resources); all others run on the EC2 instance. See the Korean section for the full matrix.

Rules:
- Every script uses `set -euo pipefail`.
- Docker builds must target arm64.
- Secrets come from script args/`read`, never hardcoded.
- AgentCore Runtime updates require `--role-arn` and `--network-configuration`.
- Code Interpreter and Memory names allow underscores only.
- Cognito and Lambda@Edge deploys stay pinned to `us-east-1`.
