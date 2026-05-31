---
sidebar_position: 2
title: 네비게이션 가이드
description: AWSops 대시보드 화면 구성 및 네비게이션 방법
---

import Screenshot from '@site/src/components/Screenshot';

# 네비게이션 가이드

AWSops 대시보드는 사이드바 기반 네비게이션을 제공합니다. 37개의 페이지가 6개 그룹으로 구성되어 있어 원하는 정보를 빠르게 찾을 수 있습니다.

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops 대시보드 전체 화면 — 사이드바, 헤더, 메인 콘텐츠 영역" />

## 화면 구성

화면은 크게 3개 영역으로 나뉩니다.

### ① 사이드바 (왼쪽)

화면 왼쪽에 고정된 네비게이션 영역입니다.

- **상단**: AWSops 로고 + EN/한 언어 전환 + Sign Out 버튼
- **Account Selector**: 멀티 어카운트 모드에서 계정 선택
- **중앙**: 6개 메뉴 그룹 (Overview, Compute, Network & CDN, Storage & DB, Monitoring, Security)
- **하단**: Cost ON/OFF 토글 + 버전 정보
- 현재 페이지는 왼쪽에 **청록색(cyan) 하이라이트**로 표시됩니다

### ② 헤더 (상단)

각 페이지 상단에 표시되는 영역입니다.

- **페이지 이름**: 현재 보고 있는 페이지 제목
- **새로고침 버튼**: 클릭 시 데이터 새로고침 (캐시 무시)
- **ONLINE 상태**: 서버 연결 상태 표시 (녹색 점 = 정상)

### ③ 메인 콘텐츠 (중앙)

선택한 페이지의 데이터가 표시되는 영역입니다.

- **대시보드**: StatsCard, 경고 현황, 차트
- **서비스 페이지**: 리소스 테이블, 상세 패널, CloudWatch 메트릭

## 메뉴 그룹

### Overview (4개 페이지)

| 메뉴 | 설명 |
|------|------|
| **Dashboard** | 전체 리소스 요약, 20개 StatsCard, 경고 현황 |
| **AI Assistant** | AI 기반 질의응답, 자연어로 인프라 분석 (멀티 데이터소스 상관 분석 지원) |
| **AgentCore** | AgentCore Runtime/Gateway 상태, 호출 통계 |
| **Accounts** | 멀티 어카운트 관리 (추가/삭제/테스트, 관리자 전용) |

### Compute (8개 페이지)

| 메뉴 | 설명 |
|------|------|
| **EC2** | EC2 인스턴스 목록 및 상세 정보 |
| **Lambda** | Lambda 함수, 런타임 분포 |
| **ECS** | ECS 클러스터, 서비스, 태스크 |
| **ECR** | ECR 리포지토리, 이미지 |
| **EKS** | EKS 클러스터 개요, 노드, Pod 요약 (Access Entry 상태, 클릭 필터링, Service Resources 탭) |
| **EKS Explorer** | K9s 스타일 터미널 UI (Steampipe 기반 읽기 전용) |
| **ECS Container Cost** | ECS Fargate 워크로드별 비용 분석 (Container Insights + Fargate 가격) |
| **EKS Container Cost** | EKS Pod별 비용 분석 (OpenCost 또는 Request 기반 폴백) |

:::tip EKS 서브페이지
EKS Overview에서 통계 카드(Nodes, Pods, Deployments, Services)를 클릭하면 각 상세 페이지로 이동합니다. 클러스터 카드를 클릭하면 해당 클러스터만 필터링됩니다.
:::

### Network & CDN (4개 페이지)

| 메뉴 | 설명 |
|------|------|
| **VPC / Network** | VPC, Subnet, Security Group, TGW, NAT |
| **CloudFront** | CloudFront 배포 현황 |
| **WAF** | WAF Web ACL, 규칙 그룹 |
| **Topology** | 인프라 토폴로지 시각화 (React Flow) |

### Storage & DB (7개 페이지)

| 메뉴 | 설명 |
|------|------|
| **EBS** | EBS 볼륨, 스냅샷, 암호화 상태 |
| **S3** | S3 버킷, TreeMap 시각화 |
| **RDS** | RDS 인스턴스, CloudWatch 메트릭 |
| **DynamoDB** | DynamoDB 테이블 |
| **ElastiCache** | ElastiCache 클러스터 (Redis/Memcached) |
| **OpenSearch** | OpenSearch 도메인 |
| **MSK** | MSK Kafka 클러스터 |

### Monitoring (8개 페이지)

| 메뉴 | 설명 |
|------|------|
| **Monitoring** | CPU, Memory, Network, Disk I/O 통합 |
| **Bedrock** | Bedrock 모델 사용량, 비용, 토큰 모니터링 |
| **CloudWatch** | CloudWatch 알람 현황 |
| **CloudTrail** | CloudTrail 트레일 및 이벤트 |
| **Cost** | Cost Explorer, 비용 분석 |
| **Resource Inventory** | 리소스 인벤토리 추이 |
| **Datasources** | 외부 데이터소스 관리 (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog) |
| **┗ Explore** | 데이터소스 쿼리 실행 + AI 쿼리 생성 (PromQL, LogQL, TraceQL, SQL) |

### Security (3개 페이지)

| 메뉴 | 설명 |
|------|------|
| **IAM** | IAM 사용자, 역할, 트러스트 정책 |
| **Security** | 보안 이슈 (Public S3, Open SG, CVE) |
| **CIS Compliance** | CIS Benchmark (v1.5 ~ v4.0) |

## 멀티 어카운트 동작 (전역 규칙)

`data/config.json`의 `accounts[]` 배열에 둘 이상의 계정이 등록되면 AWSops는 **멀티 어카운트 모드**로 동작합니다. 이 동작은 거의 모든 페이지에 공통 적용되므로 개별 가이드에서는 별도로 반복하지 않습니다.

### 사이드바 AccountSelector
사이드바 상단에 드롭다운이 나타나며 다음 항목을 선택할 수 있습니다:
- **All Accounts** — Steampipe Aggregator(`aws`) 사용, 모든 계정 데이터 통합 조회
- **개별 계정** — `aws_{accountId}` connection 사용, 단일 계정으로 스코프

선택은 URL 쿼리스트링 또는 쿠키로 페이지 간 유지됩니다.

### useAccount() 훅
모든 페이지 컴포넌트는 다음과 같이 현재 선택된 계정을 읽고 fetch에 첨부합니다:
```tsx
const { currentAccountId, isMultiAccount } = useAccountContext();
// ...
fetch('/awsops/api/steampipe', {
  method: 'POST',
  body: JSON.stringify({ accountId: currentAccountId, queries: {...} }),
});
```

서버 측 `buildSearchPath(accountId)`가 `public, aws_{id}, kubernetes, trivy` 순으로 PostgreSQL `search_path`를 구성해 쿼리를 해당 계정으로 한정합니다.

### DataTable Account 컬럼 자동 추가
`DataTable` 컴포넌트는 `isMultiAccount && data[0]?.account_id`가 true이면 첫 번째 컬럼으로 **Account**를 자동 삽입하고, 값을 `AccountBadge`(별칭 + 컬러 도트)로 렌더링합니다. 페이지마다 별도 처리할 필요가 없습니다.

이를 정상 동작시키려면 모든 AWS 테이블 `list` 쿼리에 **`account_id` 컬럼이 반드시 포함**되어야 합니다 (CLAUDE.md 데이터 접근 규칙 참고).

### Cost 쿼리의 특수 처리
Cost Explorer API는 계정별로 호출해야 하므로 `runCostQueriesPerAccount()`가 계정마다 별도 실행한 뒤 응답에 `account_id`를 태깅해 병합합니다. 단일 계정 모드에서는 이 분기를 우회합니다.

### 페이지별 예외
- **외부 데이터소스** (`/datasources`, `/datasources/explore`) — 글로벌 리소스라서 AccountSelector 영향을 받지 않습니다.
- **AgentCore / Bedrock 모니터링** — Host 계정 기준 메트릭만 표시.
- **이벤트 사전 스케일링** — 등록 시 `accountId`를 명시 지정. 미지정 이벤트는 모든 계정에서 조회됨.

## Cost 토글

사이드바 하단의 **Cost: ON/OFF** 버튼으로 비용 관련 기능을 활성화/비활성화할 수 있습니다.

- **ON**: Cost 메뉴 표시, 대시보드에 비용 카드 표시
- **OFF**: Cost 메뉴 숨김 (MSP 환경 등 Cost Explorer 미지원 시)

:::tip Cost Explorer 자동 감지
대시보드는 시작 시 Cost Explorer API 가용성을 자동으로 확인합니다. 사용 불가능한 환경에서는 자동으로 OFF 상태가 됩니다.
:::

## 페이지 이동

### 사이드바에서 이동
원하는 메뉴를 클릭하면 해당 페이지로 이동합니다. 현재 페이지는 왼쪽에 청록색(cyan) 강조 표시됩니다.

### 대시보드 카드에서 이동
대시보드의 각 StatsCard를 클릭하면 해당 서비스의 상세 페이지로 이동합니다.

예시:
- **EC2 카드 클릭** → EC2 페이지로 이동
- **Security Issues 카드 클릭** → Security 페이지로 이동
- **EKS 카드 클릭** → EKS 페이지로 이동

## 데이터 새로고침

### 자동 새로고침
페이지 로드 시 자동으로 최신 데이터를 조회합니다. 데이터는 5분간 캐시됩니다.

### 수동 새로고침
헤더의 새로고침 버튼을 클릭하면 캐시를 무시하고 최신 데이터를 조회합니다.

## 다음 단계

- [AI 어시스턴트 빠른 시작](../getting-started/ai-assistant) - AI 기능 활용하기
- [대시보드 상세](../overview/dashboard) - 대시보드 기능 자세히 알아보기
