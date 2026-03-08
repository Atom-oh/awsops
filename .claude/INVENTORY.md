# Project Inventory / 프로젝트 인벤토리 (Auto-Generated / 자동 생성)
> Auto-updated by `.claude/hooks/post-save.sh` — do not edit manually.
> (`.claude/hooks/post-save.sh`에 의해 자동 업데이트 — 수동 편집 금지.)
> Last updated: 2026-03-06 08:09 UTC (최종 업데이트: 2026-03-06 08:09 UTC)

| Category (카테고리) | Count (수량) |
|----------|-------|
| Pages (페이지) | 24 |
| API Routes (API 라우트) | 4 |
| Query Files (쿼리 파일) | 16 |
| Components (컴포넌트) | 14 |
| Skills (스킬) | 3 |
| ADRs (아키텍처 결정 기록) | 3 |
| Runbooks (런북) | 2 |
| Prompts (프롬프트) | 1 |
| Scripts (스크립트) | 11 |

## Pages / 페이지
- `/awsops/ai` → `src/app/ai/page.tsx`
- `/awsops/cloudtrail` → `src/app/cloudtrail/page.tsx`
- `/awsops/cloudwatch` → `src/app/cloudwatch/page.tsx`
- `/awsops/compliance` → `src/app/compliance/page.tsx`
- `/awsops/cost` → `src/app/cost/page.tsx`
- `/awsops/dynamodb` → `src/app/dynamodb/page.tsx`
- `/awsops/ec2` → `src/app/ec2/page.tsx`
- `/awsops/ecs` → `src/app/ecs/page.tsx`
- `/awsops/elasticache` → `src/app/elasticache/page.tsx`
- `/awsops/iam` → `src/app/iam/page.tsx`
- `/awsops/k8s/deployments` → `src/app/k8s/deployments/page.tsx`
- `/awsops/k8s/explorer` → `src/app/k8s/explorer/page.tsx`
- `/awsops/k8s/nodes` → `src/app/k8s/nodes/page.tsx`
- `/awsops/k8s` → `src/app/k8s/page.tsx`
- `/awsops/k8s/pods` → `src/app/k8s/pods/page.tsx`
- `/awsops/k8s/services` → `src/app/k8s/services/page.tsx`
- `/awsops/lambda` → `src/app/lambda/page.tsx`
- `/awsops/monitoring` → `src/app/monitoring/page.tsx`
- `/awsops/` → `src/app/page.tsx`
- `/awsops/rds` → `src/app/rds/page.tsx`
- `/awsops/s3` → `src/app/s3/page.tsx`
- `/awsops/security` → `src/app/security/page.tsx`
- `/awsops/topology` → `src/app/topology/page.tsx`
- `/awsops/vpc` → `src/app/vpc/page.tsx`

## API Routes / API 라우트
- `/awsops/api/ai` → `src/app/api/ai/route.ts` (AI 라우팅)
- `/awsops/api/benchmark` → `src/app/api/benchmark/route.ts` (벤치마크)
- `/awsops/api/code` → `src/app/api/code/route.ts` (코드 실행)
- `/awsops/api/steampipe` → `src/app/api/steampipe/route.ts` (Steampipe 쿼리)

## Query Files / 쿼리 파일
- `cloudtrail` (5 queries / 5개 쿼리)
- `cloudwatch` (4 queries / 4개 쿼리)
- `cost` (4 queries / 4개 쿼리)
- `dynamodb` (3 queries / 3개 쿼리)
- `ec2` (5 queries / 5개 쿼리)
- `ecs` (5 queries / 5개 쿼리)
- `elasticache` (6 queries / 6개 쿼리)
- `iam` (5 queries / 5개 쿼리)
- `k8s` (15 queries / 15개 쿼리)
- `lambda` (4 queries / 4개 쿼리)
- `metrics` (13 queries / 13개 쿼리)
- `rds` (4 queries / 4개 쿼리)
- `relationships` (8 queries / 8개 쿼리)
- `s3` (4 queries / 4개 쿼리)
- `security` (7 queries / 7개 쿼리)
- `vpc` (17 queries / 17개 쿼리)

## Components / 컴포넌트
- `src/components/charts/BarChartCard.tsx` (막대 차트 카드)
- `src/components/charts/LineChartCard.tsx` (라인 차트 카드)
- `src/components/charts/PieChartCard.tsx` (파이 차트 카드)
- `src/components/dashboard/CategoryCard.tsx` (카테고리 카드)
- `src/components/dashboard/LiveResourceCard.tsx` (실시간 리소스 카드)
- `src/components/dashboard/StatsCard.tsx` (통계 카드)
- `src/components/dashboard/StatusBadge.tsx` (상태 배지)
- `src/components/k8s/K9sClusterHeader.tsx` (K9s 클러스터 헤더)
- `src/components/k8s/K9sDetailPanel.tsx` (K9s 상세 패널)
- `src/components/k8s/K9sResourceTable.tsx` (K9s 리소스 테이블)
- `src/components/k8s/NamespaceFilter.tsx` (네임스페이스 필터)
- `src/components/layout/Header.tsx` (헤더)
- `src/components/layout/Sidebar.tsx` (사이드바)
- `src/components/table/DataTable.tsx` (데이터 테이블)

## Skills / 스킬
- `code-review` → `.claude/skills/code-review/SKILL.md` (코드 리뷰)
- `refactor` → `.claude/skills/refactor/SKILL.md` (리팩토링)
- `release` → `.claude/skills/release/SKILL.md` (릴리스)

## Architecture Decisions / 아키텍처 결정 기록
- `001-steampipe-pg-pool.md` — ADR-001: Steampipe pg Pool over CLI (Steampipe pg Pool 사용 결정)
- `002-ai-hybrid-routing.md` — ADR-002: AI Hybrid Routing (AI 하이브리드 라우팅)
- `003-scp-column-handling.md` — ADR-003: SCP-Blocked Column Handling (SCP 차단 컬럼 처리)

## Runbooks / 런북
- `add-new-page.md` — Runbook: Add New Dashboard Page (새 대시보드 페이지 추가)
- `start-services.md` — Runbook: Start Services (서비스 시작)

## Prompts / 프롬프트
- `analyze-resources.md` — Prompt: Analyze AWS Resources (AWS 리소스 분석)

## Scripts / 스크립트
- `00-deploy-infra.sh` — Deploy EC2 Infrastructure via CloudFormation (CloudFormation으로 EC2 인프라 배포)
- `01-install-base.sh` — Steampipe + Plugins + Powerpipe Installation (Steampipe + 플러그인 + Powerpipe 설치)
- `02-setup-nextjs.sh` — Next.js + Steampipe Service Setup (Next.js + Steampipe 서비스 설정)
- `03-build-deploy.sh` — Build & Deploy Next.js Production (Next.js 프로덕션 빌드 및 배포)
- `04-setup-alb.sh` — ALB Listener Setup for Dashboard (대시보드용 ALB 리스너 설정)
- `05-setup-cognito.sh` — Cognito Authentication Setup (Cognito 인증 설정)
- `06-setup-agentcore.sh` — AgentCore Runtime + Gateway Setup (AgentCore 런타임 + 게이트웨이 설정)
- `07-start-all.sh` — Start All Services (전체 서비스 시작)
- `08-stop-all.sh` — Stop All Services (전체 서비스 중지)
- `09-verify.sh` — Verification & Health Check (검증 및 상태 확인)
- `install-all.sh` — Full Installation (전체 설치)
