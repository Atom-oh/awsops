---
remarp: true
block: 02
title: "Architecture Deep Dive"
---

<!-- Slide 1: Block 2 Intro -->

@type: section
@transition: fade

# Architecture Deep Dive
## AWSops 기술 아키텍처

:::notes
{timing: 1min}
이제 AWSops가 어떻게 만들어졌는지, 기술 아키텍처를 상세히 살펴보겠습니다.
인프라부터 데이터 레이어, AI 엔진, 보안까지 순서대로 진행합니다.
Level 300 세션답게 내부 구현 디테일까지 다루겠습니다.
{cue: transition}
전체 아키텍처 다이어그램부터 보겠습니다.
:::

---

<!-- Slide 2: Overall Architecture Diagram -->

@type: content
@transition: slide

# Overall Architecture

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">Client</div>
    <div class="flow-box">Browser</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Edge</div>
    <div class="flow-box">CloudFront</div>
    <div class="flow-box">Lambda@Edge</div>
    <div class="flow-box">Cognito JWT</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="3">
    <div class="flow-group-label">Application</div>
    <div class="flow-box">ALB (Internal)</div>
    <div class="flow-box">EC2 t4g.2xlarge</div>
    <div class="flow-box">Next.js 14</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="4">
    <div class="flow-group-label">Data + AI</div>
    <div class="flow-box">Steampipe PostgreSQL</div>
    <div class="flow-box">Bedrock AgentCore</div>
    <div class="flow-box">8 MCP Gateways</div>
  </div>
</div>
:::

:::notes
{timing: 3min}
전체 아키텍처는 4개 계층입니다.

클라이언트 브라우저에서 시작하여 CloudFront를 거칩니다. CloudFront에는 Lambda@Edge가 붙어있고, 여기서 Cognito JWT 토큰을 검증합니다. 인증되지 않은 요청은 여기서 차단됩니다.

{cue: pause}

인증을 통과하면 Internal ALB로 라우팅됩니다. ALB 뒤에는 Private Subnet의 EC2 인스턴스가 있고, Next.js 14 App Router가 실행됩니다. EC2는 t4g.2xlarge ARM 인스턴스를 사용합니다. Graviton 기반이라 x86 대비 20% 가격 절감이 있습니다.

데이터는 Steampipe의 내장 PostgreSQL에서 조회하고, AI 분석은 Bedrock AgentCore를 통해 처리합니다.

{cue: question}
중요한 포인트는, EC2에 Public IP가 없습니다. CloudFront + ALB를 통해서만 접근 가능하고, ALB의 Security Group은 CloudFront Managed Prefix List만 허용합니다.

{cue: transition}
CDK로 이 전체 인프라를 코드로 관리합니다.
:::

---

<!-- Slide 3: CDK Infrastructure -->

@type: content
@transition: slide

# CDK Infrastructure-as-Code

:::: left

### `infra-cdk/` 구조 {.click}

- **awsops-stack.ts** — VPC, EC2, ALB, CloudFront
- **cognito-stack.ts** — User Pool, Lambda@Edge
- `cdk deploy` 한 번에 전체 인프라 생성

### 네트워크 설계 {.click}

- VPC — 기존 VPC 사용 또는 자동 생성
- EC2 — **Private Subnet** (Public IP 없음)
- ALB — Internal, CloudFront Prefix List만 허용
- CloudFront — **CACHING_DISABLED** (실시간 데이터)

::::

:::: right

### EC2 인스턴스 설정 {.click}

- **t4g.2xlarge** (8 vCPU, 32GB, ARM64)
- Steampipe + Next.js + Powerpipe 동시 실행
- IMDSv2 강제 (Hop Limit 2)
- SSM Session Manager 접근 (SSH 불필요)

### CloudFront 설정 {.click}

- X-Custom-Secret 헤더로 ALB 원본 검증
- CACHING_DISABLED 정책 (실시간 데이터)
- Lambda@Edge Python 3.12 (us-east-1)

::::

:::notes
{timing: 2min}
인프라는 CDK 두 개의 스택으로 관리합니다.

awsops-stack.ts가 핵심인데, VPC, EC2, ALB, CloudFront를 하나의 스택으로 생성합니다. 기존 VPC가 있으면 파라미터로 전달해서 재사용할 수 있고, 없으면 자동으로 새 VPC를 만듭니다.

중요한 설계 결정이 CloudFront의 CACHING_DISABLED입니다. 일반적으로 CloudFront는 캐싱을 위해 사용하지만, AWSops는 실시간 데이터 대시보드라서 캐싱을 끄고, 순수하게 보안과 글로벌 엣지 접근을 위해 사용합니다.

{cue: transition}
이제 데이터 레이어를 보겠습니다.
:::

---

<!-- Slide 4: Data Layer — Steampipe -->

@type: content
@transition: slide

# Data Layer: Steampipe

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">AWS APIs</div>
    <div class="flow-box">EC2, S3, RDS...</div>
    <div class="flow-box">380+ Tables</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Steampipe</div>
    <div class="flow-box">Embedded PostgreSQL</div>
    <div class="flow-box">Port 9193</div>
    <div class="flow-box">FDW Plugin</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="3">
    <div class="flow-group-label">Application</div>
    <div class="flow-box">pg Pool (max: 5)</div>
    <div class="flow-box">node-cache (5min TTL)</div>
    <div class="flow-box">batchQuery (5 seq)</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="4">
    <div class="flow-group-label">Multi-Account</div>
    <div class="flow-box">Aggregator</div>
    <div class="flow-box">buildSearchPath()</div>
    <div class="flow-box">Per-Account Cache</div>
  </div>
</div>
:::

:::notes
{timing: 3min}
데이터 레이어의 핵심은 Steampipe입니다.

Steampipe는 AWS API를 PostgreSQL 테이블로 변환하는 오픈소스 도구입니다. EC2 인스턴스 목록을 보려면 SELECT * FROM aws_ec2_instance 하면 됩니다. AWS CLI로 describe-instances를 호출하는 것보다 660배 빠릅니다.

{cue: pause}

왜 그렇게 빠르냐면, Steampipe CLI를 쓰면 매번 프로세스를 띄우고, 플러그인을 로드하고, 연결을 맺어야 합니다. 하지만 pg Pool로 직접 연결하면 이미 떠있는 PostgreSQL에 SQL을 보내기만 하면 됩니다. 이것이 아키텍처의 핵심 결정 중 하나였습니다.

멀티 어카운트는 Aggregator 패턴을 사용합니다. aws라는 연결명은 모든 계정을 통합 조회하고, aws_123456789012처럼 계정 ID를 붙이면 개별 계정만 조회합니다. buildSearchPath 함수가 search_path를 동적으로 생성합니다.

캐시는 node-cache로 5분 TTL을 적용합니다. 멀티 어카운트 환경에서는 캐시 키에 accountId를 접두사로 붙여서 계정별로 분리합니다.

{cue: transition}
다음은 AI 엔진입니다.
:::

---

<!-- Slide 5: AI Engine — Bedrock AgentCore -->

@type: content
@transition: slide

# AI Engine: Bedrock AgentCore

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">AI Runtime</div>
    <div class="flow-box">Strands Agent (Python)</div>
    <div class="flow-box">Claude Opus 4.6</div>
    <div class="flow-box">Docker ARM64</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">8 MCP Gateways</div>
    <div class="flow-box">Network (17 tools)</div>
    <div class="flow-box">Container (24 tools)</div>
    <div class="flow-box">Data (24 tools)</div>
    <div class="flow-box">Security (14 tools)</div>
    <div class="flow-box">+4 more</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="3">
    <div class="flow-group-label">19 Lambda Functions</div>
    <div class="flow-box">VPC Reachability</div>
    <div class="flow-box">Flow Log Analysis</div>
    <div class="flow-box">IAM Simulator</div>
    <div class="flow-box">K8s Troubleshoot</div>
    <div class="flow-box">+15 more</div>
  </div>
</div>
:::

:::notes
{timing: 3min}
AI 엔진의 핵심은 Bedrock AgentCore입니다.

AgentCore Runtime에서 Strands Agent가 실행됩니다. Python으로 작성된 에이전트가 Docker ARM64 이미지로 패키징되어 AgentCore 관리형 서비스에서 실행됩니다. EC2에서는 Docker 이미지를 빌드만 하고, 실제 실행은 AgentCore가 담당합니다.

{cue: pause}

8개의 MCP Gateway가 전문 영역별로 나뉘어 있습니다. Network Gateway는 VPC, TGW, VPN, Reachability Analyzer 등 17개 도구를 제공합니다. Container Gateway는 EKS, ECS, Istio 관련 24개 도구를 가지고 있습니다.

각 Gateway 뒤에는 19개의 Lambda 함수가 실제 작업을 수행합니다. 예를 들어 VPC Reachability Analyzer는 Lambda에서 Network Insights Path를 생성하고 분석 결과를 반환합니다.

총 125개의 도구가 이 구조를 통해 AI 에이전트에 제공됩니다.

{cue: transition}
이 125개의 도구를 어떻게 자동으로 선택하느냐가 다음 주제입니다.
:::

---

<!-- Slide 6: AI Route Classification -->

@type: content
@transition: slide

# AI Route Classification

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">User Input</div>
    <div class="flow-box">"EKS 비용 개선점 찾아줘"</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Sonnet 4.6 Classifier</div>
    <div class="flow-box">Route Registry</div>
    <div class="flow-box">18 Routes</div>
    <div class="flow-box">Intent Classification</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="3">
    <div class="flow-group-label">Handler</div>
    <div class="flow-box">auto-collect</div>
    <div class="flow-box">sql</div>
    <div class="flow-box">datasource</div>
    <div class="flow-box">code</div>
    <div class="flow-box">gateway</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="4">
    <div class="flow-group-label">Response</div>
    <div class="flow-box">SSE Streaming</div>
    <div class="flow-box">Tool Usage Display</div>
  </div>
</div>
:::

:::notes
{timing: 3min}
AI 라우팅의 핵심은 ROUTE_REGISTRY라는 단일 소스입니다.

18개의 라우트가 등록되어 있고, 각 라우트에는 gateway, display name, description, tools, examples가 정의되어 있습니다. 새로운 도구를 추가하면 분류 프롬프트, UI 표시, 게이트웨이 매핑이 자동으로 업데이트됩니다.

{cue: pause}

분류 흐름을 보면, 사용자가 자연어로 질문하면 Sonnet 4.6 모델이 18개 라우트 중 1-3개를 선택합니다. 멀티 라우트도 지원합니다. 예를 들어 "VPC 보안그룹과 비용을 분석해줘"라고 하면 network과 cost 두 라우트가 선택됩니다.

핸들러 타입이 5가지 있습니다. auto-collect는 자동 데이터 수집 에이전트, sql은 Steampipe 직접 쿼리, datasource는 Prometheus 같은 외부 데이터소스, code는 Python 코드 인터프리터, gateway는 MCP Gateway 호출입니다.

{cue: transition}
auto-collect가 가장 흥미로운 부분입니다.
:::

---

<!-- Slide 7: Auto-Collect Agents -->

@type: content
@transition: slide

# Auto-Collect Agents

:::: left

### 6 Collectors {.click}

| Agent | Target |
|-------|--------|
| **eks-optimize** | EKS rightsizing |
| **db-optimize** | RDS/ElastiCache/OpenSearch |
| **msk-optimize** | MSK Kafka brokers |
| **idle-scan** | Unused resources |
| **trace-analyze** | Distributed traces |
| **incident** | Multi-source incidents |

::::

:::: right

### 4-Phase Architecture {.click}

1. **Detect** -- 데이터소스 자동 탐지
   - Prometheus, Loki, Tempo, CloudWatch
2. **Collect** -- 병렬 데이터 수집
   - PromQL + Steampipe SQL + CloudWatch
3. **Format** -- Bedrock 컨텍스트 포맷팅
   - `formatContext()` 메서드
4. **Analyze** -- Opus 4.6 심층 분석
   - `analysisPrompt` 시스템 프롬프트

### Collector Interface {.click}

```
interface Collector {
  collect(send, accountId?)
  formatContext(data)
  analysisPrompt: string
  displayName: string
}
```

::::

:::notes
{timing: 3min}
Auto-Collect Agent는 AWSops의 가장 강력한 기능입니다.

6개의 Collector가 있고, 모두 같은 인터페이스를 구현합니다. collect 메서드로 데이터를 수집하고, formatContext로 Bedrock에 전달할 컨텍스트를 만들고, analysisPrompt로 분석 프롬프트를 제공합니다.

{cue: pause}

4단계 아키텍처를 보면, 첫 번째 Detect 단계에서 사용 가능한 데이터소스를 자동 탐지합니다. Prometheus가 연결되어 있으면 PromQL을 사용하고, 없으면 CloudWatch와 Steampipe만으로 분석합니다. 이 Graceful Degradation이 핵심입니다.

예를 들어 eks-optimize는 Prometheus에서 CPU/Memory 사용량, CPU Throttling, Pod 재시작, HTTP 에러율을 수집하고, Steampipe에서 K8s 리소스 request/limit를 수집합니다. 없는 메트릭은 건너뜁니다. 이를 MetricCandidate 패턴이라고 합니다. 여러 PromQL 쿼리를 순서대로 시도하고, 첫 번째로 데이터가 반환되는 쿼리를 사용합니다.

{cue: transition}
데이터소스 통합을 좀 더 자세히 보겠습니다.
:::

---

<!-- Slide 8: Datasource Integration -->

@type: content
@transition: slide

# Datasource Integration

:::html
<div class="flow-h">
  <div class="flow-group bg-orange" data-fragment-index="1">
    <div class="flow-group-label">Metrics</div>
    <div class="flow-box">Prometheus (PromQL)</div>
    <div class="flow-box">Datadog (Query)</div>
    <div class="flow-box">Dynatrace (API)</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="2">
    <div class="flow-group-label">Logs</div>
    <div class="flow-box">Loki (LogQL)</div>
    <div class="flow-box">ClickHouse (SQL)</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-blue" data-fragment-index="3">
    <div class="flow-group-label">Traces</div>
    <div class="flow-box">Tempo (TraceQL)</div>
    <div class="flow-box">Jaeger (API)</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="4">
    <div class="flow-group-label">Unified</div>
    <div class="flow-box">datasource-client.ts</div>
    <div class="flow-box">datasource-registry.ts</div>
    <div class="flow-box">Auto-Discovery</div>
  </div>
</div>
:::

:::notes
{timing: 2min}
AWSops는 7가지 외부 데이터소스를 지원합니다.

메트릭은 Prometheus, Datadog, Dynatrace. 로그는 Loki와 ClickHouse. 트레이스는 Tempo와 Jaeger입니다.

{cue: pause}

모든 데이터소스는 datasource-registry.ts에 메타데이터가 등록되어 있습니다. 쿼리 언어, 헬스체크 엔드포인트, 기본 포트, 예제 쿼리가 포함됩니다. datasource-client.ts가 통합 쿼리 인터페이스를 제공해서, queryDatasource 함수 하나로 어떤 데이터소스든 쿼리할 수 있습니다.

Auto-Discovery 기능이 있어서, data/config.json에 URL만 등록하면 헬스체크로 연결 가능 여부를 자동 감지합니다. 사용자 질문에서 키워드를 분석해서 적절한 데이터소스로 자동 라우팅합니다.

{cue: transition}
마지막으로 보안 아키텍처를 보겠습니다.
:::

---

<!-- Slide 9: Security Architecture -->

@type: content
@transition: slide

# Security Architecture

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">Authentication</div>
    <div class="flow-box">Cognito User Pool</div>
    <div class="flow-box">Lambda@Edge (Python)</div>
    <div class="flow-box">JWT Verification</div>
    <div class="flow-box">HttpOnly Cookie</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Network Security</div>
    <div class="flow-box">Private Subnet Only</div>
    <div class="flow-box">No Public IP</div>
    <div class="flow-box">CF Prefix List &rarr; ALB SG</div>
    <div class="flow-box">X-Custom-Secret Header</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="3">
    <div class="flow-group-label">Access Control</div>
    <div class="flow-box">IMDSv2 (Hop Limit 2)</div>
    <div class="flow-box">SSM Session Manager</div>
    <div class="flow-box">Admin Email List</div>
    <div class="flow-box">Per-User Memory</div>
  </div>
</div>
:::

:::notes
{timing: 2min}
보안은 3계층 방어입니다.

인증 계층에서는 Cognito User Pool과 Lambda@Edge를 사용합니다. Lambda@Edge가 CloudFront에서 모든 요청의 JWT 토큰을 검증합니다. 토큰이 없거나 만료되면 Cognito 로그인 페이지로 리다이렉트합니다. 로그아웃 시 HttpOnly 쿠키는 브라우저 JavaScript로 삭제할 수 없기 때문에 서버 사이드 API를 통해 삭제합니다.

{cue: pause}

네트워크 계층에서는 EC2가 Private Subnet에만 있고 Public IP가 없습니다. ALB Security Group은 CloudFront Managed Prefix List만 허용합니다. 추가로 X-Custom-Secret 헤더로 ALB가 CloudFront를 통한 요청인지 검증합니다. 이 헤더가 없는 직접 ALB 접근은 차단됩니다.

접근 제어 계층에서는 IMDSv2를 강제하고 Hop Limit 2로 컨테이너 환경에서의 메타데이터 접근도 차단합니다. SSH 대신 SSM Session Manager를 사용하고, Accounts 페이지 같은 관리 기능은 adminEmails 설정으로 접근을 제한합니다.

{cue: transition}
정리하겠습니다.
:::

---

<!-- Slide 10: Architecture Decisions -->

@type: content
@transition: slide

# Key Architecture Decisions

:::: left

### Performance Decisions {.click}

- **pg Pool > Steampipe CLI** -- 660x faster
- **node-cache 5min TTL** -- 대시보드 23개 쿼리 프리워밍
- **batchQuery (5 sequential)** -- 동시 연결 제한 준수
- **cache-warmer** -- 4분 주기 백그라운드 워밍

### AI Decisions {.click}

- **Sonnet 4.6** -- 라우트 분류 (빠르고 정확)
- **Opus 4.6** -- 종합진단 리포트 (깊은 분석)
- **MetricCandidate** -- PromQL 자동 탐색 패턴

::::

:::: right

### Resilience Decisions {.click}

- **Graceful Degradation** -- 데이터소스 없으면 Skip
- **Cost Availability Probe** -- MSP 환경 자동 감지
- **Snapshot Fallback** -- Cost API 실패 시 로컬 스냅샷
- **Inventory Snapshot** -- 추가 쿼리 0건으로 추이 추적

### Multi-Account Decisions {.click}

- **config.json** -- 코드 수정 없이 계정 추가
- **Aggregator** -- 통합/개별 조회 모두 지원
- **buildSearchPath()** -- 동적 search_path 생성
- **Per-Account Cache** -- accountId 접두사 캐시키

::::

:::notes
{timing: 2min}
주요 아키텍처 결정을 정리합니다.

성능 측면에서 가장 중요한 결정은 Steampipe CLI 대신 pg Pool을 사용한 것입니다. 660배 차이는 대시보드 사용성에 결정적이었습니다.

AI 측면에서는 분류에 빠른 Sonnet을, 심층 분석에 강력한 Opus를 분리해서 사용합니다. MetricCandidate 패턴은 다양한 Prometheus 환경에서 호환성을 보장합니다.

{cue: pause}

복원력 측면에서 Graceful Degradation이 핵심입니다. Prometheus가 없어도 CloudWatch와 Steampipe만으로 분석합니다. Cost API가 차단된 MSP 환경에서도 로컬 스냅샷으로 동작합니다.

멀티 어카운트는 config.json 하나만 수정하면 코드 변경 없이 계정을 추가할 수 있습니다.

{cue: transition}
마지막 슬라이드입니다.
:::

---

<!-- Slide 11: Technology Stack Summary -->

@type: content
@transition: fade

# Technology Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| **Frontend** | Next.js 14 | App Router, Tailwind, Recharts, React Flow |
| **Data** | Steampipe | 380+ AWS, 60+ K8s tables, pg Pool |
| **AI Model** | Bedrock Claude | Sonnet 4.6 (classify), Opus 4.6 (analyze) |
| **AI Runtime** | AgentCore | Strands Agent, 8 Gateways, 125 Tools |
| **Functions** | Lambda | 19 functions (MCP tool implementations) |
| **Auth** | Cognito | User Pool + Lambda@Edge + CloudFront |
| **Infra** | CDK | VPC, EC2, ALB, CloudFront as Code |
| **Observability** | Multi-Source | Prometheus, Loki, Tempo, Jaeger, Datadog, Dynatrace, ClickHouse |

:::notes
{timing: 1min}
기술 스택을 한 눈에 보여드리는 정리 슬라이드입니다.

프론트엔드는 Next.js 14, 데이터는 Steampipe, AI는 Bedrock과 AgentCore, 인증은 Cognito, 인프라는 CDK입니다.

특히 Observability 계층에서 7가지 외부 데이터소스를 통합 지원하는 것이 AWSops의 차별점입니다.

{cue: transition}
핵심 내용을 정리하겠습니다.
:::

---

<!-- Slide 12: Key Takeaways -->

@type: content
@transition: fade

# Key Takeaways -- Architecture

- **Steampipe pg Pool** -- AWS API를 SQL로, CLI 대비 660x 성능
- **AgentCore + 8 MCP Gateway** -- 125 도구를 전문 영역별로 분리
- **Route Registry** -- 18 라우트 단일 소스, Sonnet 자동 분류
- **Auto-Collect 4-Phase** -- Detect → Collect → Format → Analyze
- **7 Datasource Integration** -- Prometheus, Loki, Tempo, Jaeger, ClickHouse, Datadog, Dynatrace
- **Zero Trust Network** -- Private Subnet + CloudFront + Lambda@Edge

:::notes
{timing: 2min}
아키텍처 파트를 6가지로 정리합니다.

첫째, Steampipe pg Pool로 AWS 리소스를 SQL로 빠르게 조회합니다.
둘째, AgentCore와 8개 MCP Gateway로 125개 도구를 전문 영역별로 관리합니다.
셋째, Route Registry 하나로 18개 라우트를 자동 분류합니다.
넷째, Auto-Collect Agent는 4단계로 데이터를 자동 수집하고 분석합니다.
다섯째, 7가지 외부 데이터소스를 통합 지원합니다.
여섯째, Private Subnet 기반 Zero Trust 네트워크입니다.

{cue: transition}
이제 실제 데모와 종합진단 리포트를 보여드리겠습니다.
:::
