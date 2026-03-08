# AWSops Dashboard - Kiro Rules / AWSops 대시보드 - Kiro 규칙

## Project Overview / 프로젝트 개요
AWS + Kubernetes operations dashboard powered by Steampipe, Next.js, and Amazon Bedrock AgentCore.
(Steampipe, Next.js, Amazon Bedrock AgentCore 기반 AWS + Kubernetes 운영 대시보드.)

## Tech Stack / 기술 스택
- **Frontend (프론트엔드)**: Next.js 14 (App Router), TypeScript, Tailwind CSS, Recharts, React Flow
- **Backend (백엔드)**: Steampipe (embedded PostgreSQL on port 9193), Powerpipe (CIS benchmarks)
- **AI (AI)**: Amazon Bedrock (Sonnet/Opus 4.6), AgentCore Runtime (Strands Agent), AgentCore Gateway (MCP)
- **Auth (인증)**: Amazon Cognito + CloudFront Lambda@Edge
- **Infra (인프라)**: CloudFormation → CloudFront → ALB → EC2 (t4g.2xlarge)

## Architecture Rules / 아키텍처 규칙

### Data Flow / 데이터 흐름
- All AWS/K8s data comes from Steampipe via pg Pool, NOT CLI (모든 AWS/K8s 데이터는 CLI가 아닌 pg Pool을 통해 Steampipe에서 가져옴)
- steampipe.ts: `Pool({ host: '127.0.0.1', port: 9193, max: 3, statement_timeout: 120000 })`
- batchQuery runs 3 queries concurrently in sequential batches (batchQuery는 순차 배치로 3개 쿼리를 동시 실행)
- Results cached for 5 minutes via node-cache (node-cache를 통해 결과 5분 캐싱)

### Next.js Configuration / Next.js 설정
- basePath: `/awsops` (set in next.config.mjs) (next.config.mjs에서 설정)
- All fetch() URLs MUST use `/awsops/api/steampipe` prefix — basePath not auto-applied to fetch (모든 fetch() URL은 반드시 `/awsops/api/steampipe` 접두사 사용 — basePath는 fetch에 자동 적용되지 않음)
- All components use `export default`, NOT named exports (모든 컴포넌트는 named export가 아닌 `export default` 사용)
- Import: `import Header from '@/components/layout/Header'`, NOT `{ Header }` (import 방식: `{ Header }`가 아닌 `import Header from '...'`)

### Steampipe Queries / Steampipe 쿼리
- Use `trivy_scan_vulnerability`, NOT `trivy_vulnerability` (`trivy_vulnerability`가 아닌 `trivy_scan_vulnerability` 사용)
- S3 uses `versioning_enabled`, NOT `versioning` (S3는 `versioning`이 아닌 `versioning_enabled` 사용)
- RDS uses `class` AS alias, NOT `db_instance_class` directly (RDS는 `db_instance_class` 직접 사용이 아닌 `class` AS 별칭 사용)
- Avoid `mfa_enabled`, `attached_policy_arns`, Lambda `tags` in list queries — SCP blocks hydrate (목록 쿼리에서 `mfa_enabled`, `attached_policy_arns`, Lambda `tags` 사용 금지 — SCP가 hydrate 차단)
- K8s node status: use `conditions::text LIKE '%"type":"Ready"%'`, NOT `jsonb_path_exists` with `$` (K8s 노드 상태: `$`가 포함된 `jsonb_path_exists`가 아닌 `conditions::text LIKE` 사용)

### AI Routing / AI 라우팅
- Network keywords (ENI, route table, reachability) → AgentCore Runtime with Gateway MCP tools (네트워크 키워드 → AgentCore Runtime + Gateway MCP 도구)
- AWS resource keywords (EC2, VPC, RDS) → Steampipe query + Bedrock Direct (AWS 리소스 키워드 → Steampipe 쿼리 + Bedrock Direct)
- General questions → AgentCore Runtime via Strands (일반 질문 → Strands를 통한 AgentCore Runtime)
- Fallback → Bedrock Direct (폴백 → Bedrock Direct)

### Dark Theme Colors / 다크 테마 색상
- Background (배경): navy-900 (#0a0e1a), navy-800 (#0f1629), navy-700 (#151d30)
- Border (테두리): navy-600 (#1a2540)
- Accents (강조색): cyan (#00d4ff), green (#00ff88), purple (#a855f7), orange (#f59e0b), red (#ef4444), pink (#ec4899)
- StatsCard/LiveResourceCard color prop: use names ('cyan', 'green') NOT hex (색상 prop은 hex가 아닌 이름 사용)

### Component Patterns / 컴포넌트 패턴
- Detail panels: fixed right overlay, bg-black/50 backdrop, max-w-2xl, animate-fade-in (상세 패널: 고정 우측 오버레이, bg-black/50 배경, max-w-2xl, 페이드인 애니메이션)
- Section/Row helpers at bottom of each page file (각 페이지 파일 하단에 Section/Row 헬퍼)
- DataTable: sortable columns, skeleton loading, onRowClick for detail (DataTable: 정렬 가능 컬럼, 스켈레톤 로딩, 행 클릭 시 상세)
- Charts: PieChartCard, BarChartCard, LineChartCard — Recharts wrappers (차트: Recharts 래퍼)

## File Structure / 파일 구조
```
src/
├── app/                    # Next.js App Router pages — 21 pages (Next.js App Router 페이지 — 21개)
├── components/             # Shared UI components (공유 UI 컴포넌트)
│   ├── layout/            # Sidebar, Header (사이드바, 헤더)
│   ├── dashboard/         # StatsCard, StatusBadge, LiveResourceCard (통계, 상태, 실시간 카드)
│   ├── charts/            # PieChartCard, BarChartCard, LineChartCard (차트 컴포넌트)
│   ├── table/             # DataTable (데이터 테이블)
│   └── k8s/               # K9s-style components (K9s 스타일 컴포넌트)
├── lib/
│   ├── steampipe.ts       # pg Pool connection + batchQuery (pg Pool 연결 + batchQuery)
│   └── queries/           # SQL query strings — 12 files (SQL 쿼리 문자열 — 12개 파일)
└── types/
    └── aws.ts             # TypeScript type definitions (TypeScript 타입 정의)
```
