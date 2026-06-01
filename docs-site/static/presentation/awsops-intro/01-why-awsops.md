---
remarp: true
block: 01
title: "Why AWSops"
---

<!-- Slide 1: Session Cover -->

@type: cover
@transition: fade

# AWSops
## AI-Powered AWS Operations Dashboard

Junseok Oh | Solutions Architect | AWS

:::notes
{timing: 1min}
안녕하세요, AWS Solutions Architect 오준석입니다.
오늘은 AWSops라는 AI 기반 AWS 운영 대시보드를 소개해 드리겠습니다.
클라우드 운영의 복잡성을 어떻게 해결하고, AI가 어떤 역할을 할 수 있는지 함께 살펴보겠습니다.
{cue: transition}
먼저 왜 이런 도구가 필요한지부터 시작하겠습니다.
:::

---

<!-- Slide 2: Agenda -->

@type: agenda

# Agenda

1. **Why AWSops** — 클라우드 운영의 도전 과제와 8가지 차별점
2. **Architecture Deep Dive** — 기술 스택과 AI 에이전트
3. **Demo & Diagnosis Report** — 실전 시나리오와 종합진단

:::notes
{timing: 1min}
총 60분 세션으로 3개 파트로 나누어 진행합니다.
첫 번째 파트에서는 왜 이런 도구가 필요한지, 그리고 AWSops가 고객 환경에 제공하는 8가지 핵심 차별점을 살펴봅니다.
두 번째로 어떻게 만들었는지 아키텍처를, 세 번째로 실제로 어떻게 쓰는지 데모와 종합진단을 보여드리겠습니다.
:::

---

<!-- Slide 3: The Challenge -->

@type: content
@transition: slide

# 클라우드 운영의 도전 과제

::: left

### Console Hopping

- EC2 확인 → CloudWatch → VPC → IAM → Cost Explorer
- **평균 5-7개 콘솔** 페이지를 오가며 문제 해결
- 멀티 어카운트 환경에서는 **로그인만 10번**

### 데이터 사일로

- CloudWatch 메트릭 ≠ Prometheus ≠ 로그 ≠ 트레이스
- **교차 분석 불가** → 근본 원인 파악 지연

:::

::: right

### 반복적 수작업

- "이 인스턴스 rightsizing 필요한가?"
- "미사용 리소스 정리해야 하는데..."
- **매번 같은 CLI 명령어** 반복 실행

### 보고서 작성 부담

- Well-Architected Review 수작업
- FinOps 리포트 매월 수동 작성
- **2-3일 소요** → 실시간성 부족

:::

:::notes
{timing: 3min}
클라우드 운영을 하다 보면 정말 많은 도전 과제에 직면합니다.

첫 번째는 Console Hopping입니다. 하나의 이슈를 해결하려면 EC2 콘솔에서 시작해서 CloudWatch로 메트릭 보고, VPC에서 네트워크 확인하고, IAM에서 권한 체크하고... 평균 5-7개 콘솔을 돌아다녀야 합니다. 멀티 어카운트면 로그인만 해도 지칩니다.

{cue: pause}

두 번째는 데이터 사일로입니다. CloudWatch 메트릭, Prometheus 메트릭, 로그, 트레이스가 각각 다른 시스템에 있어서 교차 분석이 어렵습니다.

세 번째, 네 번째도 마찬가지로 반복 작업과 보고서 부담이 큽니다.

{cue: question}
여러분도 이런 경험 있으시죠? 특히 FinOps 리포트를 매달 수동으로 만들어 본 경험이 있으신 분?

{cue: transition}
AWSops는 이 문제들을 한 화면, 하나의 AI 어시스턴트로 동시에 해결합니다.
:::

---

<!-- Slide 4: AWSops Overview — Single Pane of Glass -->

@type: content
@transition: slide

# AWSops — Single Pane of Glass

:::html
<div class="tab-bar" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
  <button class="tab-btn" style="padding:8px 16px;border:none;border-radius:6px;background:#00d4ff;color:#0a0e1a;font-weight:bold;cursor:pointer;font-size:14px;" onclick="(function(b,i){var p=b.closest('.slide-body')||b.parentNode.parentNode.parentNode;p.querySelectorAll('.tc').forEach(function(c,j){c.style.display=j===i?'block':'none'});var btns=b.parentNode.querySelectorAll('.tab-btn');btns.forEach(function(x){x.style.background='#1a2540';x.style.color='#b0b0b0';x.classList.remove('active')});b.style.background='#00d4ff';b.style.color='#0a0e1a';b.classList.add('active')})(this,0)">Data Layer</button>
  <button class="tab-btn" style="padding:8px 16px;border:none;border-radius:6px;background:#1a2540;color:#b0b0b0;font-weight:bold;cursor:pointer;font-size:14px;" onclick="(function(b,i){var p=b.closest('.slide-body')||b.parentNode.parentNode.parentNode;p.querySelectorAll('.tc').forEach(function(c,j){c.style.display=j===i?'block':'none'});var btns=b.parentNode.querySelectorAll('.tab-btn');btns.forEach(function(x){x.style.background='#1a2540';x.style.color='#b0b0b0';x.classList.remove('active')});b.style.background='#00d4ff';b.style.color='#0a0e1a';b.classList.add('active')})(this,1)">AI Engine</button>
  <button class="tab-btn" style="padding:8px 16px;border:none;border-radius:6px;background:#1a2540;color:#b0b0b0;font-weight:bold;cursor:pointer;font-size:14px;" onclick="(function(b,i){var p=b.closest('.slide-body')||b.parentNode.parentNode.parentNode;p.querySelectorAll('.tc').forEach(function(c,j){c.style.display=j===i?'block':'none'});var btns=b.parentNode.querySelectorAll('.tab-btn');btns.forEach(function(x){x.style.background='#1a2540';x.style.color='#b0b0b0';x.classList.remove('active')});b.style.background='#00d4ff';b.style.color='#0a0e1a';b.classList.add('active')})(this,2)">Dashboard</button>
</div>
<div class="tc" style="display:block;padding:12px;background:rgba(15,22,41,0.5);border-radius:8px;">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
  <div style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.3);border-radius:8px;padding:20px;">
    <div style="color:#00d4ff;font-weight:bold;font-size:18px;margin-bottom:8px;">Steampipe — SQL for Cloud</div>
    <div style="color:#b0b0b0;line-height:1.6;">AWS API를 PostgreSQL 테이블로 변환<br>CLI 대비 <span style="color:#00ff88;font-weight:bold;">660x</span> 빠른 쿼리 + node-cache 5분 캐싱</div>
  </div>
  <div style="display:grid;grid-template-rows:1fr 1fr;gap:12px;">
    <div style="background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#00d4ff;font-size:28px;font-weight:bold;">380+</div>
      <div style="color:#8b95a5;font-size:13px;">AWS Tables</div>
    </div>
    <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#00ff88;font-size:28px;font-weight:bold;">60+</div>
      <div style="color:#8b95a5;font-size:13px;">K8s Tables</div>
    </div>
  </div>
</div>
</div>
<div class="tc" style="display:none;padding:12px;background:rgba(15,22,41,0.5);border-radius:8px;">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
  <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:20px;">
    <div style="color:#f59e0b;font-weight:bold;font-size:18px;margin-bottom:8px;">Bedrock AgentCore</div>
    <div style="color:#b0b0b0;line-height:1.6;">Sonnet 4.6 (빠른 분류·라우팅)<br>Opus 4.8 (심층 진단)<br>Haiku 4.5 (저비용·고빈도)</div>
  </div>
  <div style="display:grid;grid-template-rows:1fr 1fr;gap:12px;">
    <div style="background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#f59e0b;font-size:28px;font-weight:bold;">8</div>
      <div style="color:#8b95a5;font-size:13px;">MCP Gateways</div>
    </div>
    <div style="background:rgba(168,85,247,0.05);border:1px solid rgba(168,85,247,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#a855f7;font-size:28px;font-weight:bold;">125</div>
      <div style="color:#8b95a5;font-size:13px;">MCP Tools</div>
    </div>
  </div>
</div>
</div>
<div class="tc" style="display:none;padding:12px;background:rgba(15,22,41,0.5);border-radius:8px;">
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
  <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:16px;text-align:center;">
    <div style="color:#ef4444;font-size:32px;font-weight:bold;">43</div>
    <div style="color:#8b95a5;font-size:13px;margin-top:4px;">Pages</div>
    <div style="color:#666;font-size:11px;">EC2, Lambda, ECS, EKS, S3, RDS, VPC...</div>
  </div>
  <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:16px;text-align:center;">
    <div style="color:#ef4444;font-size:32px;font-weight:bold;">20</div>
    <div style="color:#8b95a5;font-size:13px;margin-top:4px;">API Routes</div>
    <div style="color:#666;font-size:11px;">AI, Steampipe, CloudWatch, Cost...</div>
  </div>
  <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:16px;text-align:center;">
    <div style="color:#ef4444;font-size:32px;font-weight:bold;">11</div>
    <div style="color:#8b95a5;font-size:13px;margin-top:4px;">AI Routes</div>
    <div style="color:#666;font-size:11px;">code, network, cost, datasource...</div>
  </div>
</div>
</div>
:::

:::notes
{timing: 3min}
AWSops는 3개 레이어로 구성됩니다.

{cue: pause}
Data Layer에서는 Steampipe가 AWS 380개 이상, Kubernetes 60개 이상의 테이블을 SQL로 조회합니다. AWS CLI보다 660배 빠르고, 결과는 node-cache로 5분간 캐싱합니다.

AI Engine에서는 Bedrock Claude가 8개의 전문 MCP Gateway를 통해 125개의 도구를 사용합니다. 분류·라우팅은 Sonnet 4.6, 심층 진단은 Opus 4.8, 빠르고 저렴한 작업은 Haiku 4.5를 씁니다.

Dashboard는 Next.js 14로 만든 43개 페이지, 20개 API 라우트, 그리고 자연어 질문을 11개 라우트로 분류하는 AI 어시스턴트로 구성됩니다.

{cue: transition}
지금부터 고객 환경에 도입할 때 핵심이 되는 8가지 차별점을 하나씩 보겠습니다.
:::

---

<!-- Slide 5: #1 Open-source / AWS-Native -->

@type: content
@transition: slide

# ① 완전 오픈소스 · AWS-Native (Architecture v1)

::: left

- **오픈소스** — 전체 소스가 공개되어 자사 계정에 그대로 배포하고 내부 요구에 맞게 수정 가능. **벤더 락인 없음**
- **AWS 매니지드 서비스만으로 구현** — 외부 SaaS 의존 없음
- 데이터·AI·인증·엣지가 전부 AWS 안에서 끝나 **데이터 거버넌스·컴플라이언스가 단순**

:::

::: right

| 레이어 | AWS 서비스 |
|--------|-----------|
| 엣지·인증 | CloudFront + Lambda@Edge + Cognito |
| 컴퓨트 | EC2 t4g.2xlarge (ARM64 Graviton) + ALB |
| AI | **Bedrock AgentCore** + Bedrock 모델 |
| IaC | AWS CDK |

:::

:::notes
{timing: 3min}
첫 번째 차별점은 완전 오픈소스이며 AWS 매니지드 서비스만으로 구현됐다는 점입니다.

전체 소스가 공개되어 있어 고객이 그대로 가져다 자사 계정에 배포하고, 내부 요구에 맞게 수정할 수 있습니다. 벤더 락인이 없습니다.

그리고 엣지·인증은 CloudFront + Lambda@Edge + Cognito, 컴퓨트는 ARM64 Graviton 기반 EC2와 ALB, AI는 Bedrock AgentCore, IaC는 CDK — 전부 AWS 매니지드 서비스로만 구성됩니다. Datadog, Grafana Cloud 같은 외부 모니터링 SaaS 비용이 아예 없고, 데이터가 고객 VPC 밖으로 나가지 않아 금융·공공·의료처럼 데이터 주권이 중요한 환경에 적합합니다.

{cue: transition}
이 모든 데이터를 빠르게 끌어오는 엔진이 Steampipe입니다.
:::

---

<!-- Slide 6: #2 Steampipe + #3 Dashboards -->

@type: content
@transition: slide

# ② Steampipe — 빠른 데이터 + 로컬 캐싱 · ③ 43 페이지 대시보드

::: left

### Steampipe 데이터 엔진

- 내장 PostgreSQL(:9193)로 **380+ AWS · 60+ K8s 테이블**을 SQL 즉시 조회
- 모든 쿼리는 **pg Pool**(max 10, 8 sequential batch)을 통해서만 — CLI는 **660x 느려 코드 레벨 금지**(ADR-001)
- node-cache **5분 캐싱** + 캐시 워머가 핵심 **23개 쿼리를 4분 주기 프리워밍** → 서브초 응답

:::

::: right

### 기본 대시보드 — 43 페이지

- EC2 · Lambda · ECS/ECR · EKS(Pod/Node/Deploy/Svc/Explorer)
- VPC · CloudFront · WAF · 토폴로지 맵(React Flow)
- EBS · S3 · RDS · DynamoDB · ElastiCache · MSK · OpenSearch
- MSK·RDS·ElastiCache·OpenSearch는 **CloudWatch 메트릭 인라인**

:::

:::notes
{timing: 3min}
두 번째와 세 번째 차별점은 데이터 엔진과 기본 대시보드입니다.

AWSops의 데이터 엔진은 Steampipe입니다. 내장 PostgreSQL로 AWS API를 SQL처럼 다루며, 380개 이상의 AWS 테이블과 60개 이상의 Kubernetes 테이블을 즉시 조회합니다. 모든 쿼리는 pg Pool을 통해서만 실행하고, Steampipe CLI는 660배 느려서 코드 레벨에서 금지하고 있습니다. 결과는 5분 캐싱하고, 대시보드 핵심 23개 쿼리는 캐시 워머가 4분 주기로 미리 데워서 서브초 응답을 보장합니다.

그 위에 43개 페이지가 EC2부터 EKS, RDS, MSK, OpenSearch까지 AWS·Kubernetes 주요 리소스를 실시간 차트와 React Flow 토폴로지로 보여줍니다.

{cue: transition}
이 데이터를 AI가 분석해 만드는 것이 종합진단 리포트입니다.
:::

---

<!-- Slide 7: #4 Well-Architected AI Diagnosis -->

@type: content
@transition: slide

# ④ Well-Architected AI 종합 진단

:::html
<div style="display:grid;grid-template-columns:1.1fr 1fr;gap:20px;margin-top:8px;">
  <div style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.3);border-radius:12px;padding:20px;">
    <div style="color:#00d4ff;font-weight:bold;font-size:17px;margin-bottom:10px;">6-Pillar Executive Summary</div>
    <div style="color:#b0b0b0;font-size:13px;line-height:1.7;">Operational Excellence · Security · Reliability · Performance Efficiency · Cost Optimization · Sustainability<br><span style="color:#8b95a5;">→ 6개 필러 전체 스코어카드</span></div>
  </div>
  <div style="background:rgba(0,255,136,0.08);border:1px solid rgba(0,255,136,0.3);border-radius:12px;padding:20px;">
    <div style="color:#00ff88;font-weight:bold;font-size:17px;margin-bottom:10px;">3-Pillar Deep Dive · 15 섹션</div>
    <div style="color:#b0b0b0;font-size:13px;line-height:1.7;">Cost Optimization · Security · Reliability를 심층 분석<br><span style="color:#8b95a5;">비용/유휴 리소스, 보안 현황, 네트워크·컴퓨팅·EKS·DB·MSK·스토리지</span></div>
  </div>
</div>
<div style="margin-top:16px;background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.3);border-radius:12px;padding:16px;text-align:center;color:#b0b0b0;font-size:14px;">
  <span style="color:#a855f7;font-weight:bold;">Claude Opus 4.8</span> 분석 → <span style="color:#fff;">DOCX · Markdown · PDF · PPTX</span> 내보내기 + <span style="color:#fff;">주간/격주/월간 자동 스케줄</span>
</div>
:::

:::notes
{timing: 3min}
네 번째 차별점은 Well-Architected 관점의 AI 종합 진단입니다.

`/ai-diagnosis` 페이지에서 Bedrock Claude Opus 4.8가 인프라 전반을 자동 분석합니다. 정직하게 범위를 말씀드리면, Executive Summary에서는 6개 Well-Architected 필러 전체에 점수를 매기는 스코어카드를 제공하고, 심층 분석은 Cost·Security·Reliability 3개 필러에 집중해 15개 섹션으로 깊게 파고듭니다. 나머지 3개 필러의 심층 섹션은 로드맵입니다.

결과는 DOCX, Markdown, PDF, PPTX로 내보낼 수 있고, 주간·격주·월간으로 자동 스케줄링됩니다. 수작업 2-3일 걸리던 리포트가 10분으로 줄어듭니다.

{cue: transition}
운영 도구 자체의 비용과 멀티 어카운트도 핵심입니다.
:::

---

<!-- Slide 8: #5 Cost Efficiency + #6 Multi-Account -->

@type: content
@transition: slide

# ⑤ 비용 효율(낮은 TCO) · ⑥ 멀티 어카운트

::: left

### 낮은 TCO

- **단일 EC2 t4g.2xlarge(ARM64)** — Steampipe 임베디드 PostgreSQL 동거 → **별도 관리형 DB 비용 없음**
- **AgentCore 서버리스** — 호출 시에만 과금
- 작업별 모델 선택 — 분류 **Sonnet 4.6** / 심층 **Opus 4.8** / 저비용 **Haiku 4.5** + 프롬프트 캐싱(ADR-016)
- 고객 인프라 비용도 절감 — 유휴 리소스 탐지·FinOps 권고

:::

::: right

### 멀티 어카운트(단일 창)

- Steampipe **Aggregator** — `aws` = 전 계정 통합, `aws_<id>` = 개별
- 상단에서 계정 전환 또는 **전체 통합 조회**
- 계정 추가/삭제는 `data/config.json`의 `accounts[]`만 수정 — **코드 변경 불필요**(ADR-008)
- 교차 계정은 **assume-role**

:::

:::notes
{timing: 3min}
다섯 번째는 비용 효율입니다. 운영 도구 자체의 비용이 낮도록 설계됐습니다. 단일 ARM64 Graviton EC2에 Steampipe 임베디드 PostgreSQL을 함께 돌려서 별도 관리형 DB 비용이 없고, AgentCore는 서버리스라 호출할 때만 과금됩니다. Bedrock 모델도 작업에 맞게 골라 씁니다 — 분류는 Sonnet 4.6, 심층 진단은 Opus 4.8, 빠르고 저렴한 작업은 Haiku 4.5, 여기에 프롬프트 캐싱까지 적용합니다. 그리고 도구가 고객 인프라의 비용도 절감합니다.

여섯 번째는 멀티 어카운트입니다. Steampipe Aggregator 패턴으로 전 계정을 단일 창에서 보거나 개별 계정으로 전환할 수 있고, 계정 추가·삭제는 config 파일의 accounts 배열만 수정하면 됩니다. 코드 변경이 전혀 필요 없습니다.

{cue: transition}
관측성과 컨테이너 비용도 한 화면에 들어옵니다.
:::

---

<!-- Slide 9: #7 EKS Cost + #8 Observability + NL Query -->

@type: content
@transition: slide

# ⑦ EKS 컨테이너 비용 · ⑧ 외부 관측성 통합 + 🆕 자연어 쿼리

::: left

### EKS/ECS 컨테이너 비용

- **OpenCost + Prometheus** — namespace·Pod·노드 단위 **실사용 기반 비용**(CPU·Mem·Storage·GPU)
- OpenCost 없으면 **Request 기반 폴백**으로 추정
- ECS는 **CloudWatch Container Insights + Fargate 가격**

:::

::: right

### 외부 관측성 7종 + 자연어 쿼리

- Metrics: Prometheus · Dynatrace · Datadog
- Logs: Loki · ClickHouse  /  Traces: Tempo · Jaeger
- `/datasources/explore`에서 **자연어 → PromQL/LogQL/TraceQL/SQL** 자동 생성 (SSRF allowlist, ADR-011)

:::

:::notes
{timing: 3min}
일곱 번째는 EKS 컨테이너 비용 추적입니다. OpenCost와 Prometheus로 네임스페이스·Pod·노드 단위의 실사용량 기반 비용을 추적하고, OpenCost가 없으면 Request 기반으로라도 추정합니다. ECS는 CloudWatch Container Insights와 Fargate 가격으로 컨테이너 비용을 산출합니다.

여덟 번째이자, 제가 강조하고 싶은 강점은 외부 관측성 통합과 자연어 쿼리입니다. AWS 데이터에 더해 Prometheus, Dynatrace, Datadog, Loki, ClickHouse, Tempo, Jaeger 7종을 데이터소스로 연동합니다. 그리고 datasources/explore에서 "결제 서비스 5xx 추이 보여줘" 같은 자연어 한 줄을 입력하면 AI가 PromQL, LogQL, TraceQL, SQL로 변환해서 실행합니다. 관측성 도구마다 다른 쿼리 언어를 외울 필요가 없어 운영자 진입장벽을 크게 낮춥니다.

{cue: transition}
코드에서 확인되는 추가 강점들도 정리했습니다.
:::

---

<!-- Slide 10: Additional strengths from code -->

@type: content

# 코드에서 확인되는 추가 강점

| 강점 | 내용 |
|------|------|
| **AI 도구 아키텍처** | 8 역할 기반 AgentCore Gateway · **125 MCP 도구** · 19 Lambda |
| **멀티 라우트 합성** | 질문을 **11개 라우트** 중 1~3개로 분류해 병렬 호출 후 종합(ADR-002/025) |
| **알림 파이프라인** | 웹훅(CloudWatch SNS/Alertmanager/Grafana) → 상관 분석 → AI 자동 진단 → Slack(ADR-009) |
| **이벤트 사전 스케일링** | 과거 메트릭 분석 → Bedrock 다단계 워밍업 플랜·스크립트(ADR-010, 검토-후-실행) |
| **CIS 컴플라이언스** | Powerpipe로 CIS v1.5~v4.0, **431개 컨트롤** 벤치마크 |
| **설계 투명성** | **32개 ADR** — 모든 주요 결정이 한국어/영어로 문서화 |

:::notes
{timing: 2min}
지금까지의 8가지 외에도 코드에서 확인되는 추가 강점들이 있습니다.

AI 도구 아키텍처는 8개 역할 기반 Gateway에 125개 MCP 도구와 19개 Lambda로 구성되고, 분류기가 질문을 11개 라우트 중 1~3개로 분류해 병렬 호출 후 종합합니다. 알림 파이프라인은 웹훅을 받아 상관 분석하고 AI가 자동 진단해서 Slack으로 보냅니다. 이벤트 사전 스케일링은 과거 메트릭을 분석해 Bedrock이 워밍업 플랜과 스크립트를 만들어 주되, 검토 후 수동 실행하는 안전한 방식입니다. CIS는 431개 컨트롤을 벤치마크하고, 32개 ADR로 모든 설계 결정이 문서화돼 있습니다.

{cue: transition}
첫 번째 파트를 정리하겠습니다.
:::

---

<!-- Slide 11: Block 1 Key Takeaways -->

@type: content
@transition: fade

# Key Takeaways — Why AWSops

- **완전 오픈소스 · AWS-Native** → 벤더 락인 없음, 데이터가 고객 VPC 밖으로 안 나감
- **Steampipe + 캐싱** → 43 페이지를 서브초 응답 Single Pane of Glass
- **Well-Architected AI 진단** → 6필러 스코어카드 + 3필러 심층 15섹션, DOCX/PDF/PPTX
- **낮은 TCO + 멀티 어카운트** → 단일 EC2, 서버리스 AI, config-only 계정 관리
- **관측성 7종 + 자연어 쿼리** → PromQL/LogQL/TraceQL/SQL 자동 생성

:::notes
{timing: 2min}
첫 번째 파트를 정리하겠습니다.

AWSops는 완전 오픈소스이며 AWS 매니지드 서비스만으로 구현돼 벤더 락인이 없고 데이터가 고객 VPC를 벗어나지 않습니다. Steampipe와 캐싱으로 43페이지 대시보드를 서브초로 띄우고, Well-Architected AI 진단으로 6필러 스코어카드와 3필러 심층 15섹션 리포트를 만듭니다. 단일 EC2와 서버리스 AI로 TCO가 낮고, 계정 관리는 config 파일만 수정하면 됩니다. 그리고 7종 관측성을 자연어 한 줄로 쿼리합니다.

{cue: transition}
이제 이것을 어떻게 만들었는지, 아키텍처를 자세히 보겠습니다.
:::
