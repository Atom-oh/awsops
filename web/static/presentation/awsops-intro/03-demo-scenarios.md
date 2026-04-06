---
remarp: true
block: 03
title: "Demo & Diagnosis Report"
---

<!-- Slide 1: Block 3 Intro -->

@type: section
@transition: fade

# Demo & Diagnosis Report
## 실전 시나리오와 종합진단

:::notes
{timing: 1min}
마지막 파트입니다. 지금까지 왜 필요한지, 어떻게 만들었는지를 봤고, 이제 실제로 어떻게 쓰는지를 데모로 보여드리겠습니다.
AI 어시스턴트 사용법, 자동 수집 에이전트, 그리고 종합진단 리포트까지 순서대로 보겠습니다.
{cue: transition}
먼저 AI 어시스턴트 데모입니다.
:::

---

<!-- Slide 2: AI Assistant Demo Flow -->

@type: content
@transition: slide

# AI Assistant Demo

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">Step 1: 질문</div>
    <div class="flow-box">"VPC 구성을 분석해줘"</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Step 2: 분류</div>
    <div class="flow-box">Sonnet 4.6</div>
    <div class="flow-box">Route: aws-data</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="3">
    <div class="flow-group-label">Step 3: 실행</div>
    <div class="flow-box">Steampipe SQL 생성</div>
    <div class="flow-box">VPC/Subnet/SG 조회</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="4">
    <div class="flow-group-label">Step 4: 분석</div>
    <div class="flow-box">Bedrock 분석</div>
    <div class="flow-box">SSE 스트리밍 응답</div>
    <div class="flow-box">Tool Usage 표시</div>
  </div>
</div>
:::

:::notes
{timing: 3min}
AI 어시스턴트의 동작 흐름을 보겠습니다.

사용자가 "VPC 구성을 분석해줘"라고 질문합니다. Sonnet 4.6이 이 질문을 분류합니다. "VPC 구성 분석"은 목록/현황 질문이므로 aws-data 라우트로 분류됩니다. network 라우트가 아닙니다. network은 Reachability Analyzer나 Flow Log 분석 같은 전문 도구가 필요한 경우에만 사용합니다.

{cue: pause}

aws-data 핸들러는 Steampipe SQL을 생성합니다. aws_vpc, aws_vpc_subnet, aws_vpc_security_group 테이블에서 데이터를 조회하고, Bedrock이 결과를 분석해서 아키텍처 개선점을 제안합니다.

응답은 SSE 스트리밍으로 실시간 전달됩니다. 어떤 도구가 사용되었는지 UI에 표시됩니다. 이것은 AgentCore 응답 텍스트에서 키워드를 추론해서 보여주는 것입니다. AgentCore는 최종 텍스트만 반환하기 때문에 tool_call 태그가 없습니다.

{cue: demo}
(데모) AI 페이지에서 "VPC 현황 분석해줘"를 입력합니다.
라우트가 aws-data로 분류되는 것을 확인하고, SQL 실행 후 분석 결과가 스트리밍되는 것을 보여줍니다.

{cue: transition}
다음은 EKS 비용 최적화 시나리오입니다.
:::

---

<!-- Slide 3: EKS Cost Optimization -->

@type: content
@transition: slide

# Scenario 1: EKS Cost Optimization

:::: left

### 사용자 질문 {.click}

> "EKS 비용 개선점 찾아줘"

### 자동 수집 데이터 {.click}

**Prometheus (PromQL)**
- CPU Usage vs Request per Container
- Memory Usage vs Request per Container
- CPU Throttling Rate
- Pod Restart Counts
- HTTP 5xx Error Rates
- Node CPU / Memory Utilization

**Steampipe SQL**
- K8s Pod resource requests/limits
- EKS Container Cost (OpenCost)

::::

:::: right

### 분석 결과 예시 {.click}

- "**payment** Pod: CPU request 500m, 실사용 50m → **90% 과할당**"
- "**frontend** Deployment: Memory limit 2Gi, 사용량 200Mi → **다운사이징 권장**"
- "Node 3대 중 **2대는 활용률 15% 미만** → Karpenter로 통합 가능"
- "예상 월 절감: **$1,200** (현재 $3,500)"

### MetricCandidate Pattern {.click}

```
{ key: 'cpuUsage',
  queries: [
    'container_cpu_usage_seconds_total
     {container!="",image!=""}',
    'container_cpu_usage_seconds_total
     {container!=""}',  // fallback
  ]}
```

::::

:::notes
{timing: 3min}
첫 번째 시나리오는 EKS 비용 최적화입니다.

사용자가 "EKS 비용 개선점 찾아줘"라고 입력하면, Sonnet이 eks-optimize 라우트로 분류합니다. auto-collect 핸들러가 작동합니다.

{cue: pause}

자동으로 Prometheus에서 9가지 메트릭을 수집합니다. 컨테이너별 CPU/Memory 사용량과 요청량을 비교하고, CPU Throttling, Pod 재시작, HTTP 에러율, 노드 활용률까지 수집합니다. Steampipe에서는 K8s Pod의 resource request/limit를 조회합니다.

MetricCandidate 패턴이 핵심인데, 각 메트릭에 대해 여러 PromQL 쿼리를 순서대로 시도합니다. 첫 번째 쿼리에서 데이터가 반환되면 그것을 사용하고, 실패하면 다음 쿼리를 시도합니다. Prometheus 환경마다 메트릭 라벨이 다를 수 있기 때문입니다.

{cue: demo}
(데모) "EKS 비용 개선점 찾아줘"를 입력합니다.
수집 진행 상태가 SSE로 실시간 표시되고, 최종적으로 Opus 4.6이 과할당 리소스와 절감 방안을 분석합니다.

{cue: transition}
다음은 유휴 리소스 스캔입니다.
:::

---

<!-- Slide 4: Idle Resource Scanner -->

@type: content
@transition: slide

# Scenario 2: Idle Resource Scanner

:::: left

### 사용자 질문 {.click}

> "미사용 리소스 찾아줘"

### 6 Categories Scan {.click}

| Category | SQL Query |
|----------|-----------|
| Unattached EBS | `status = 'available'` |
| gp2 Volumes | `volume_type = 'gp2'` |
| Unassociated EIPs | `association_id IS NULL` |
| Stopped EC2 | `instance_state = 'stopped'` |
| Old Snapshots | `start_time < NOW() - 90 days` |
| Unused SGs | ENI 참조 없음 |

::::

:::: right

### 비용 추정 로직 {.click}

- EBS: volume_type + size 기반 월 비용 계산
- EIP: **$3.6/month** per unassociated IP
- EC2: instance_type 기반 On-Demand 가격
- Snapshot: size + storage 단가
- gp2 → gp3: **20% 절감** 추정

### 분석 결과 예시 {.click}

> "6개 미연결 EBS (총 500GB) → **$50/월**"
> "3개 미연결 EIP → **$10.8/월**"
> "12개 gp2 볼륨 → gp3 전환 시 **$30/월 절감**"
> "**총 예상 월 낭비: $240**"

::::

:::notes
{timing: 2min}
두 번째 시나리오는 유휴 리소스 스캔입니다.

"미사용 리소스 찾아줘"라고 하면 idle-scan 라우트로 분류됩니다. 6가지 카테고리의 Steampipe SQL을 병렬로 실행합니다.

{cue: pause}

미연결 EBS 볼륨, gp2 볼륨, 미연결 Elastic IP, 중지된 EC2, 90일 이상 된 스냅샷, ENI에 연결되지 않은 Security Group을 스캔합니다. 각 카테고리별로 서울 리전 가격 기반으로 월 비용을 추정합니다.

이 에이전트는 Prometheus가 필요 없습니다. Steampipe SQL만으로 동작하기 때문에 어떤 환경에서든 즉시 사용할 수 있습니다.

{cue: transition}
세 번째 시나리오입니다.
:::

---

<!-- Slide 5: Incident Analysis -->

@type: content
@transition: slide

# Scenario 3: Incident Analysis

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">CloudWatch</div>
    <div class="flow-box">ALARM 상태 알람</div>
    <div class="flow-box">K8s Warning Events</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Prometheus</div>
    <div class="flow-box">HTTP 5xx Spike</div>
    <div class="flow-box">CPU/Memory Anomaly</div>
    <div class="flow-box">Pod Restart Surge</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="3">
    <div class="flow-group-label">Loki</div>
    <div class="flow-box">Error Log Patterns</div>
    <div class="flow-box">Exception Traces</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="4">
    <div class="flow-group-label">Tempo / Jaeger</div>
    <div class="flow-box">Error Traces</div>
    <div class="flow-box">Latency Outliers</div>
  </div>
</div>
:::

### Cross-Source Correlation → Opus 4.6 분석 → Timeline 재구성

:::notes
{timing: 3min}
세 번째 시나리오는 인시던트 분석입니다. "장애 원인 분석해줘"라고 입력하면 incident 라우트가 선택됩니다.

이 에이전트가 가장 많은 데이터소스를 교차 분석합니다.

{cue: pause}

먼저 CloudWatch에서 ALARM 상태인 알람을 조회하고, Steampipe로 K8s Warning 이벤트를 가져옵니다. 이것은 항상 사용 가능합니다.

Prometheus가 있으면 HTTP 5xx 스파이크, CPU/Memory 이상 징후, Pod 재시작 급증을 감지합니다. Loki가 있으면 에러 로그 패턴과 Exception 스택트레이스를 검색합니다. Tempo나 Jaeger가 있으면 에러 트레이스와 지연시간 이상값을 수집합니다.

이 모든 데이터를 Opus 4.6에 전달하면, 시간순 타임라인을 재구성하고 근본 원인을 분석합니다. "14:30에 payment 서비스의 DB 커넥션 풀이 고갈되어 5xx가 발생했고, 이것이 order 서비스로 전파되어 전체 장애로 확대됨" 같은 분석을 제공합니다.

{cue: transition}
이제 종합진단 리포트를 보겠습니다.
:::

---

<!-- Slide 6: Comprehensive Diagnosis Report -->

@type: content
@transition: slide

# Comprehensive Diagnosis Report

:::: left

### 15 Sections {.click}

| # | Section | Pillar |
|---|---------|--------|
| 1 | Executive Summary | - |
| 2 | Cost Overview | Cost Optimization |
| 3 | Compute Cost | Cost Optimization |
| 4 | Network Cost | Cost Optimization |
| 5 | Storage Cost | Cost Optimization |
| 6 | Idle Resources | Cost Optimization |
| 7 | Security Posture | Security |
| 8 | Network Architecture | Reliability |
| 9 | Compute Analysis | Performance |
| 10 | EKS Analysis | Performance |
| 11 | Database Analysis | Performance |
| 12 | MSK Analysis | Performance |
| 13 | Storage Analysis | Operational |
| 14 | Recommendations | Sustainability |
| 15 | Appendix | - |

::::

:::: right

### Architecture {.click}

:::html
<div style="display: flex; flex-direction: column; gap: 12px;">
  <div class="flow-box" style="background: rgba(0,212,255,0.1); border-color: rgba(0,212,255,0.3);">1. Data Collection (report-generator.ts)<br>Steampipe Batch + Auto-Collect Agents</div>
  <div style="text-align: center; color: #00d4ff;">&darr;</div>
  <div class="flow-box" style="background: rgba(0,255,136,0.1); border-color: rgba(0,255,136,0.3);">2. AI Analysis (5 batches x 3 sections)<br>Opus 4.6 per section, Well-Architected prompts</div>
  <div style="text-align: center; color: #00ff88;">&darr;</div>
  <div class="flow-box" style="background: rgba(168,85,247,0.1); border-color: rgba(168,85,247,0.3);">3. Background Worker + Progress<br>Async generation, SSE progress tracking</div>
  <div style="text-align: center; color: #a855f7;">&darr;</div>
  <div class="flow-box" style="background: rgba(245,158,11,0.1); border-color: rgba(245,158,11,0.3);">4. S3 Storage + Download<br>DOCX / Markdown / Print-to-PDF</div>
</div>
:::

### Scheduling {.click}

- Weekly / Biweekly / Monthly 자동 실행
- KST 기준 스케줄링
- S3 보관 + 이력 관리

::::

:::notes
{timing: 3min}
종합진단 리포트는 AWSops의 플래그십 기능입니다.

15개 섹션이 Well-Architected Framework의 6 Pillar에 매핑됩니다. Cost Optimization, Security, Reliability, Performance Efficiency, Operational Excellence, Sustainability를 모두 커버합니다.

{cue: pause}

아키텍처를 보면, 첫 번째로 report-generator.ts가 Steampipe 배치 쿼리와 Auto-Collect Agent로 데이터를 수집합니다. EKS, DB, MSK, Idle 데이터까지 병렬로 수집합니다.

두 번째로 15개 섹션을 5개 배치(3개씩)로 나누어 Opus 4.6이 분석합니다. 각 섹션마다 전문 시스템 프롬프트가 있습니다. 예를 들어 Cost Overview 섹션은 FinOps 전문가 관점에서 비용 추이, 서비스별 분포, 최적화 전략을 분석합니다.

세 번째로 비동기 백그라운드 워커가 실행되고, SSE로 진행률을 실시간 표시합니다. "3/15 Security Posture 분석 중..." 같은 상태가 클라이언트에 표시됩니다.

완성된 리포트는 S3에 저장되고, DOCX, Markdown, 브라우저 Print-to-PDF로 다운로드할 수 있습니다.

{cue: transition}
FinOps 도구를 좀 더 자세히 보겠습니다.
:::

---

<!-- Slide 7: FinOps MCP Tools -->

@type: content
@transition: slide

# FinOps MCP Tools

:::: left

### Cost Gateway (9 tools) {.click}

- **Cost Explorer** — 비용/사용량 분석, 기간 비교
- **Cost Forecast** — 비용 예측
- **Pricing API** — AWS 서비스 가격 조회
- **Budgets** — 예산 상태 확인

### Auto-Collect Agents {.click}

- **eks-optimize** — K8s rightsizing
- **db-optimize** — RDS/ElastiCache/OpenSearch
- **msk-optimize** — Kafka broker sizing
- **idle-scan** — 낭비 리소스 탐지

::::

:::: right

### AWS Native FinOps {.click}

- **Compute Optimizer** — EC2/Lambda/EBS 권장
- **RI/SP Recommendations** — 예약 인스턴스/Savings Plan
- **Cost Optimization Hub** — 통합 최적화 권장
- **Trusted Advisor** — 비용 최적화 검사

### 통합 비용 분석 {.click}

- ECS: CloudWatch Container Insights + Fargate 가격
- EKS: OpenCost API + Request 기반 폴백
- 멀티 어카운트: 계정별 비용 쿼리 → 태깅 병합

::::

:::notes
{timing: 2min}
FinOps 도구를 정리하면 3가지 레벨입니다.

첫 번째는 Cost Gateway의 9개 MCP 도구입니다. Cost Explorer로 서비스별 비용을 분석하고, Forecast로 향후 비용을 예측하고, Budgets로 예산 초과를 모니터링합니다.

{cue: pause}

두 번째는 Auto-Collect Agent입니다. eks-optimize, db-optimize, msk-optimize, idle-scan이 각각 전문 영역의 리소스 최적화를 담당합니다. 이 에이전트들은 실제 사용량 데이터를 수집해서 구체적인 다운사이징 권장사항을 제시합니다.

세 번째는 AWS Native FinOps 도구입니다. Compute Optimizer, RI/SP Recommendations, Cost Optimization Hub, Trusted Advisor와 연동합니다.

컨테이너 비용은 ECS는 CloudWatch Container Insights와 Fargate 가격으로, EKS는 OpenCost API로 계산합니다. OpenCost가 없으면 resource request 기반 폴백을 사용합니다.

{cue: transition}
배포 방법을 보겠습니다.
:::

---

<!-- Slide 8: Deployment -->

@type: content
@transition: slide

# Deployment — 30 Minutes

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">Phase 1: Infra (5min)</div>
    <div class="flow-box">00 CDK Deploy</div>
    <div class="flow-box">01 Install Base</div>
    <div class="flow-box">02 Setup Next.js</div>
    <div class="flow-box">03 Build & Deploy</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Phase 2: Auth (5min)</div>
    <div class="flow-box">05 Cognito</div>
    <div class="flow-box">08 CloudFront Auth</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="3">
    <div class="flow-group-label">Phase 3: AI (15min)</div>
    <div class="flow-box">06a Runtime</div>
    <div class="flow-box">06b Gateways</div>
    <div class="flow-box">06c Tools (125)</div>
    <div class="flow-box">06d Interpreter</div>
    <div class="flow-box">06e Memory</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="4">
    <div class="flow-group-label">Phase 4: Optional</div>
    <div class="flow-box">07 OpenCost</div>
    <div class="flow-box">12 Multi-Account</div>
    <div class="flow-box">11 Verify</div>
  </div>
</div>
:::

:::notes
{timing: 2min}
배포는 총 12개 스크립트이고, install-all.sh 하나로 전체를 자동 실행할 수 있습니다.

Phase 1에서 CDK로 인프라를 만들고, Steampipe와 Next.js를 설치하고, 프로덕션 빌드를 합니다. 약 5분 소요됩니다.

{cue: pause}

Phase 2에서 Cognito User Pool을 생성하고 Lambda@Edge를 CloudFront에 연결합니다. Phase 3에서 AgentCore Runtime, 8개 Gateway, 125개 Tools, Code Interpreter, Memory Store를 설정합니다. 이 단계가 가장 오래 걸려서 약 15분입니다.

Phase 4는 선택 사항입니다. OpenCost는 EKS 비용 분석을 위해 필요하고, Multi-Account는 교차 계정 분석을 위해 설정합니다.

전체 30분이면 AI 기반 AWS 운영 대시보드가 완성됩니다.

{cue: transition}
마무리하겠습니다.
:::

---

<!-- Slide 9: Conclusion & Next Steps -->

@type: content
@transition: slide

# Conclusion & Next Steps

:::: left

### AWSops가 해결하는 문제 {.click}

- **Console Hopping** → 36페이지 Single Pane of Glass
- **데이터 사일로** → 7 Datasource 통합
- **반복 수작업** → 6 Auto-Collect Agents
- **보고서 부담** → 15섹션 자동 종합진단

### 핵심 차별점 {.click}

- Zero SaaS Dependency
- 고객 VPC 내 100% 실행
- Bedrock AI (외부 AI API 불필요)
- 30분 배포

::::

:::: right

### Getting Started {.click}

1. CDK로 인프라 배포
2. `install-all.sh` 실행
3. Cognito 사용자 추가
4. AI 어시스턴트에서 질문 시작

### Next Steps {.click}

- 데이터소스 연동 (Prometheus, Loki, Tempo)
- 멀티 어카운트 설정
- 종합진단 리포트 자동 스케줄링
- CIS 벤치마크 정기 실행

::::

:::notes
{timing: 2min}
AWSops를 정리하면, 클라우드 운영의 4대 도전 과제를 AI로 해결하는 대시보드입니다.

Console Hopping 대신 36페이지 대시보드, 데이터 사일로 대신 7가지 데이터소스 통합, 반복 작업 대신 6개 AI 에이전트, 수동 보고서 대신 15섹션 자동 종합진단을 제공합니다.

{cue: pause}

가장 중요한 차별점은 외부 SaaS 의존성이 제로라는 것입니다. 모든 것이 고객의 AWS 계정 안에서 실행됩니다. 데이터가 밖으로 나가지 않습니다.

시작하려면 CDK로 인프라를 배포하고 install-all.sh를 실행하면 됩니다. 30분이면 됩니다.

{cue: question}
질문이 있으시면 편하게 해주세요.

{cue: transition}
마지막 슬라이드입니다.
:::

---

<!-- Slide 10: Thank You -->

@type: cover
@transition: fade

# Thank You

## AWSops — AI-Powered AWS Operations Dashboard

Junseok Oh | Solutions Architect | AWS

:::notes
{timing: 1min}
감사합니다. 질문이 있으시면 지금 받겠습니다.

발표 후 추가 질문이 있으시면 언제든 연락 주세요.
AWSops는 내부에서 계속 발전하고 있고, 새로운 기능이 지속적으로 추가되고 있습니다.

오늘 보여드린 Auto-Collect Agent 패턴, Route Registry 패턴, Graceful Degradation 패턴은 여러분의 프로젝트에도 적용할 수 있는 범용적인 아키텍처 패턴입니다.

감사합니다.
:::
