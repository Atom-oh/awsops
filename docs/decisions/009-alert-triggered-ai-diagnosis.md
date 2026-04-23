# ADR-009: Alert-Triggered AI Diagnosis / 알림 트리거 AI 자동 진단

## Status: Accepted (2026-04-22) / 상태: 채택됨

## Context / 컨텍스트

AWSops provides comprehensive AI diagnosis through manual triggers (AI chat, 15-section report, auto-scheduler). However, when an operational incident actually occurs -- a CloudWatch alarm fires, Prometheus Alertmanager triggers, or Kubernetes pods crash-loop -- the operations team must manually open the dashboard and ask questions to understand root cause. The gap between "alert fires" and "root cause identified" averages 15-30 minutes of manual investigation.

AWSops는 수동 트리거(AI 채팅, 15섹션 리포트, 자동 스케줄러)를 통한 포괄적 AI 진단을 제공한다. 그러나 실제 운영 장애 발생 시 -- CloudWatch 알람, Prometheus Alertmanager 트리거, Kubernetes Pod 크래시 루프 -- 운영팀은 대시보드에 수동 접속하여 원인을 파악해야 한다. "알림 발생"부터 "근본 원인 파악"까지 평균 15-30분의 수동 조사가 소요된다.

### Problem Statement / 문제 정의

1. **Reactive gap**: Alerts notify that something is wrong, but don't explain why. Human investigation is required to cross-correlate CloudWatch metrics, Kubernetes events, application logs, traces, and recent changes.
   반응적 격차: 알림은 문제 발생만 알리고 원인은 설명하지 않는다. CloudWatch 메트릭, K8s 이벤트, 로그, 트레이스, 최근 변경사항을 교차 분석하는 인적 조사가 필요하다.

2. **Alert fatigue**: When multiple related alerts fire simultaneously (e.g., high CPU + HTTP 5xx + pod restarts), each alert is treated independently. Teams waste time investigating symptoms rather than the single root cause.
   알림 피로: 관련 알림이 동시에 발생하면(예: 높은 CPU + HTTP 5xx + Pod 재시작) 각각을 독립적으로 처리한다. 증상 조사에 시간을 낭비하는 대신 단일 근본 원인에 집중해야 한다.

3. **Knowledge loss**: Past incident investigations are not systematically captured. When a similar alert fires again, the team starts from scratch instead of referencing prior diagnosis.
   지식 손실: 과거 장애 조사가 체계적으로 기록되지 않는다. 유사한 알림 재발 시 이전 진단을 참조하는 대신 처음부터 다시 시작한다.

### What Already Exists / 기존 인프라

AWSops has powerful infrastructure that can be leveraged directly:

| Capability | Component | Details |
|------------|-----------|---------|
| Multi-source incident analysis | `src/lib/collectors/incident.ts` | CloudWatch + K8s Events + Prometheus + Loki + Tempo in parallel |
| 7 specialized collectors | `src/lib/collectors/*.ts` | EKS optimize, DB optimize, MSK, idle scan, trace analyze, network flow |
| 125 MCP tools via 8 Gateways | AgentCore Runtime | Network, Container, Security, Monitoring, Cost, Data, IaC, Ops |
| 7 external datasource types | `src/lib/datasource-client.ts` | Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog |
| AI query generation | `src/lib/datasource-prompts.ts` | Natural language to PromQL/LogQL/TraceQL/SQL auto-generation |
| Multi-route parallel AI | `src/app/api/ai/route.ts` | 17-route classifier + parallel execution + synthesis |
| 15-section report pipeline | `src/lib/report-generator.ts` | Batched Bedrock Opus analysis + DOCX/MD export |
| Background task patterns | `cache-warmer.ts`, `report-scheduler.ts` | Lazy-init, interval check, file-based state, error isolation |
| SNS notifications | `src/lib/sns-notification.ts` | Topic management, mailing list, formatted notifications |
| Conversation memory | `src/lib/agentcore-memory.ts` | Per-user session storage, keyword search, statistics |

---

## Decision / 결정

Build a **multi-stage AI diagnosis pipeline** that automatically receives alerts from external systems, correlates related alerts into incidents, investigates root cause using all available AWSops tools, and delivers actionable analysis to Slack/SNS.

외부 시스템에서 알림을 자동 수신하고, 관련 알림을 인시던트로 상관 분석하며, 사용 가능한 모든 AWSops 도구를 활용하여 근본 원인을 조사하고, 실행 가능한 분석 결과를 Slack/SNS로 전달하는 **다단계 AI 진단 파이프라인**을 구축한다.

### Architecture Overview / 아키텍처 개요

> **Networking constraint / 네트워크 제약**: EC2 is in a Private Subnet behind CloudFront → ALB. CloudFront has Cognito Lambda@Edge authentication, which blocks unauthenticated HTTP requests (including SNS HTTP subscriptions). Therefore, **CloudWatch Alarm alerts must use the SNS → SQS → EC2 Polling path** (not direct webhook). Webhook is reserved for VPC-internal sources (Alertmanager, Grafana) that can reach ALB directly.
>
> EC2는 CloudFront → ALB 뒤의 Private Subnet에 위치. CloudFront에 Cognito Lambda@Edge 인증이 적용되어 있어 인증 없는 HTTP 요청(SNS HTTP 구독 포함)이 차단됨. 따라서 **CloudWatch Alarm 알림은 반드시 SNS → SQS → EC2 Polling 경로**를 사용해야 함. Webhook은 ALB에 직접 접근 가능한 VPC 내부 소스(Alertmanager, Grafana) 전용.

```
Alert Sources                    AWSops Pipeline                        Output
================                ===================                   ========

CloudWatch Alarm ──► SNS Topic ──► SQS Queue ──► alert-sqs-poller.ts
                                      │                │
                   (SNS Fan-out OK)   └► DLQ (3x fail) │
                                                       ▼
                                             Alert Normalizer
Alertmanager ──webhook──┐                        │
  (VPC internal)        ├──► /api/alert-webhook ─┤
Grafana ──webhook───────┘                        │
  (VPC internal)                       ┌─────────▼──────────┐
                                       │ Correlation Engine │
                                       │  (time + service   │
                                       │   + resource)      │
                                       └─────────┬──────────┘
                                                 │
                                       ┌─────────▼──────────┐
                                       │ Investigation      │──► Slack
                                       │ Orchestrator       │    (Block Kit)
                                       │                    │
                                       │ ┌─Collectors─────┐ │──► SNS Email
                                       │ │ incident       │ │
                                       │ │ trace-analyze  │ │──► Dashboard
                                       │ │ eks-optimize   │ │    Alert History
                                       │ └────────────────┘ │
                                       │ ┌─Datasources────┐ │──► Memory Store
                                       │ │ Prometheus     │ │    (knowledge)
                                       │ │ Loki logs      │ │
                                       │ │ Tempo traces   │ │
                                       │ └────────────────┘ │
                                       │ ┌─Change Detect──┐ │
                                       │ │ CloudTrail     │ │
                                       │ │ K8s Rollouts   │ │
                                       │ └────────────────┘ │
                                       │                    │
                                       │ Bedrock Opus 4.6   │
                                       │ Root Cause Analysis │
                                       └────────────────────┘
```

---

### Stage 1: Alert Ingestion / 알림 수집

Two ingestion paths exist, each serving different source types:

**Path A (Primary): SNS → SQS → EC2 Polling** — for CloudWatch Alarms and other AWS-native alerts.
CloudWatch Alarm → SNS Topic (`awsops-alert-topic`) → SQS Queue (`awsops-alert-queue`) → `alert-sqs-poller.ts` polls every 30 seconds. This path avoids the CloudFront + Cognito Lambda@Edge authentication barrier.

경로 A (Primary): CloudWatch Alarm 등 AWS 네이티브 알림용. CloudWatch Alarm → SNS Topic → SQS Queue → `alert-sqs-poller.ts`가 30초마다 폴링. CloudFront + Cognito Lambda@Edge 인증 장벽을 회피.

**Path B (Secondary): Direct Webhook** — for VPC-internal sources (Alertmanager, Grafana) that can reach ALB directly without going through CloudFront.

경로 B (Secondary): ALB에 직접 접근 가능한 VPC 내부 소스(Alertmanager, Grafana) 전용 Webhook.

**New file**: `src/app/api/alert-webhook/route.ts` (VPC-internal sources only)

| Source | Delivery | Path | Detection Method |
|--------|----------|------|-----------------|
| CloudWatch Alarm | **SNS → SQS → Poller** | A (Primary) | SNS envelope: `Type: "Notification"` + `Message.AlarmName` |
| Prometheus Alertmanager | Webhook POST (VPC internal) | B | `alerts[]` array with `labels`, `annotations`, `startsAt` |
| Grafana Alerting | Webhook POST (VPC internal) | B | `alerts[]` with `dashboardURL`, `panelURL` |
| Generic / Custom | Webhook POST (VPC internal) | B | `source` + `title` + `severity` + `message` |

> **Why not SNS → Webhook directly?** EC2 is in a Private Subnet. External access is only through CloudFront → ALB, but CloudFront has Cognito Lambda@Edge authentication. SNS HTTP subscriptions send `SubscriptionConfirmation` and `Notification` requests without authentication headers, so Lambda@Edge rejects them with 401/403. Using SQS as an intermediary completely avoids this issue since EC2 polls SQS outbound (no inbound networking required).
>
> **왜 SNS → Webhook 직접 경로가 안 되는가?** EC2는 Private Subnet에 위치하고 외부 접근은 CloudFront → ALB를 통해서만 가능. CloudFront에 Cognito Lambda@Edge 인증이 적용되어 있어 SNS의 `SubscriptionConfirmation`과 `Notification` 요청이 인증 헤더 없이 전송되므로 Lambda@Edge가 401/403으로 거부. SQS를 중간 매개로 사용하면 EC2가 아웃바운드로 SQS를 폴링하므로 이 문제를 완전히 회피.

**Security**:
- SQS: Messages are authenticated by AWS IAM (SNS → SQS subscription policy). No external HTTP endpoint exposed.
- Webhook: HMAC-SHA256 signature verification per source (configurable secret per source)
- Webhook: Rate limiting: 60 requests/min per source IP
- Webhook: SNS subscription confirmation auto-response retained for testing/fallback
- Both: Replay protection — reject alerts older than 15 minutes

**Normalization** to unified `AlertEvent`:
```typescript
interface AlertEvent {
  id: string;                    // deterministic hash (source + alertName + labels)
  source: AlertSource;           // 'cloudwatch' | 'alertmanager' | 'grafana' | 'sqs' | 'generic'
  alertName: string;
  severity: 'critical' | 'warning' | 'info';
  status: 'firing' | 'resolved';
  message: string;
  timestamp: string;             // ISO 8601
  labels: Record<string, string>; // namespace, service, instance, region, etc.
  annotations: Record<string, string>; // summary, description, runbook_url, dashboard
  metric?: {                     // for metric-based alerts
    name: string;                // e.g., "CPUUtilization", "http_requests_total"
    namespace?: string;          // CloudWatch namespace or Prometheus job
    value?: number;
    threshold?: number;
    comparator?: string;         // "GreaterThanThreshold", ">", etc.
    dimensions?: Record<string, string>;
  };
  rawPayload: unknown;
}
```

**CloudWatch-specific parsing**: Extract `Trigger.MetricName`, `Trigger.Namespace`, `Trigger.Dimensions`, `NewStateReason`, `OldStateValue` from SNS Message JSON. Map severity from `ALARM` → `critical`, `INSUFFICIENT_DATA` → `warning`.

**Alertmanager-specific parsing**: Extract `alerts[].labels.severity` (or infer from `alertname` conventions), `startsAt`/`endsAt`, `generatorURL`. Support grouped alerts (single webhook with multiple `alerts[]`).

---

### Stage 2: Alert Correlation Engine / 알림 상관 분석 엔진

**New file**: `src/lib/alert-correlation.ts`

Related alerts often fire within seconds of each other. Instead of diagnosing each independently, the correlation engine groups them into **Incidents**.

**Correlation Strategy** (multi-dimensional):

```typescript
interface Incident {
  id: string;
  status: 'investigating' | 'analyzed' | 'resolved';
  severity: 'critical' | 'warning' | 'info';
  alerts: AlertEvent[];          // grouped alerts
  primaryAlert: AlertEvent;      // highest-severity or earliest alert
  correlationReason: string;     // why these alerts are grouped
  affectedServices: string[];    // extracted from labels
  affectedResources: string[];   // e.g., "i-0abc123", "my-pod-xyz"
  createdAt: string;
  analyzedAt?: string;
  diagnosisResult?: DiagnosisResult;
}
```

**Correlation Rules** (evaluated in order):

| Rule | Match Criteria | Example |
|------|---------------|---------|
| Same Resource | `labels.instance` or `labels.pod` or `dimensions.InstanceId` match | CPU alarm + Memory alarm on same EC2 |
| Same Service | `labels.service` or `labels.namespace` match within 5-min window | HTTP 5xx + latency spike on same service |
| Dependency Chain | Service A depends on Service B (from trace topology) | DB connection errors + DB CPU alarm |
| Same Deployment | K8s `labels.app` + recent rollout detected | Pod CrashLoopBackOff + OOMKilled after deploy |
| Time Window | Multiple unrelated alerts within 2-min window | Likely same root cause (e.g., AZ failure) |

**Deduplication**: Alerts with the same `id` (deterministic hash of source + alertName + labels) within a configurable window (default: 15 minutes) are deduplicated. Only the first instance triggers investigation.

**Severity Escalation**: An incident's severity auto-escalates when:
- 3+ alerts accumulate → minimum `warning`
- Any `critical` alert joins → escalate to `critical`
- Alert from a new service joins → re-run diagnosis with broader scope

**Buffering Window**: New alerts are buffered for 30 seconds before triggering investigation. This allows related alerts to be grouped into the same incident rather than spawning parallel diagnosis runs.

---

### Stage 3: Investigation Orchestrator / 조사 오케스트레이터

**New file**: `src/lib/alert-diagnosis.ts`

The orchestrator selects investigation strategies based on alert context, runs them in parallel, then feeds all results to Bedrock Opus for root cause analysis.

**Strategy Selection** (based on alert labels and metrics):

```typescript
interface InvestigationPlan {
  collectors: string[];          // which auto-collect collectors to run
  datasourceQueries: DatasourceQuery[]; // specific queries to run
  changeDetection: boolean;      // check recent changes
  gatewayInvestigation?: {       // optional deep investigation via AgentCore
    gateway: string;
    prompt: string;
  };
}
```

**Decision Matrix**:

| Alert Signal | Investigation Actions |
|-------------|----------------------|
| CloudWatch CPU/Memory alarm | `incident` collector + Prometheus per-pod metrics + recent K8s rollouts |
| HTTP 5xx error rate | `trace-analyze` collector + Loki error logs + Prometheus request metrics |
| Pod CrashLoopBackOff | `eks-optimize` collector + K8s events + Loki pod logs + recent deployments |
| RDS/ElastiCache alarm | `db-optimize` collector + CloudWatch detailed metrics + connection pool queries |
| MSK consumer lag | `msk-optimize` collector + Prometheus Kafka JMX metrics |
| Disk/EBS alarm | `idle-scan` collector (EBS) + CloudWatch IOPS/throughput |
| Network connectivity | `network-flow` collector (ClickHouse) + VPC flow log analysis |
| Security alert (GuardDuty) | CloudTrail events + IAM changes + Security Gateway investigation |
| Generic/Unknown | `incident` collector (full multi-source scan) |

**Signal detection** uses keyword matching on `alertName`, `labels`, `metric.name`, and `metric.namespace` -- similar to the existing `detectDatasourceTypes()` pattern in `datasource-registry.ts`.

**Parallel Investigation Execution**:

```
Phase 1 (parallel, 30s timeout):
├── Selected Collectors (incident, trace-analyze, etc.)
├── Targeted Datasource Queries (Prometheus, Loki, Tempo)
└── Change Detection (CloudTrail + K8s rollouts)

Phase 2 (sequential, after Phase 1):
├── Bedrock Opus Root Cause Analysis
└── Optional: AgentCore Gateway deep investigation
    (triggered if Phase 1 data is insufficient)
```

**Change Detection Module**:

One of the most valuable signals for root cause analysis is "what changed recently?"

```typescript
interface RecentChanges {
  cloudtrailEvents: CloudTrailEvent[];  // last 1h, filtered by affected service
  k8sRollouts: K8sRollout[];           // deployments/statefulsets with recent rollout
  configChanges: ConfigChange[];         // recent parameter group/security group changes
}
```

- **CloudTrail**: Query via Steampipe SQL for events matching the alert's resource/service in the last 1-2 hours. Filter for mutating events: `CreateStack`, `UpdateService`, `PutScalingPolicy`, `ModifyDBInstance`, `RunInstances`, etc.
- **K8s Rollouts**: Query `kubernetes_deployment` where `conditions` contains recent rollout, or `kubernetes_event` with `reason = 'ScalingReplicaSet'`.
- **Impact**: "A deployment occurred 12 minutes before the alert" is often the single most useful piece of information for root cause.

**Bedrock Analysis Prompt**:

The diagnosis prompt is significantly more structured than the existing incident collector's prompt:

```
You are an expert SRE performing automated incident diagnosis.

## Incident Context
- Alert: {alertName} ({severity}) from {source}
- Fired at: {timestamp}
- Affected: {services}, {resources}
- Related alerts: {correlatedAlerts}

## Investigation Data
{formattedCollectorResults}
{formattedDatasourceResults}
{formattedRecentChanges}

## Analysis Requirements

### 1. Timeline Reconstruction
Build a chronological timeline of events leading to this incident.
Correlate timestamps across all data sources. Identify the trigger event.

### 2. Root Cause Identification
- Primary root cause with confidence level (HIGH/MEDIUM/LOW)
- Evidence chain: which specific data points support this conclusion
- Alternative hypotheses if confidence is not HIGH

### 3. Impact Assessment
- Affected services and user-facing impact
- Blast radius: could this spread to other services?
- SLO/SLA implications if known

### 4. Immediate Remediation
- Step-by-step actions to resolve (kubectl commands, AWS CLI, console steps)
- Rollback procedure if a recent change is the root cause
- Workarounds while permanent fix is developed

### 5. Prevention
- What monitoring gap allowed this to go undetected earlier?
- Suggested additional alerts or dashboards
- Configuration or architectural changes to prevent recurrence

### 6. Similar Past Incidents
If the knowledge base contains similar incidents, reference them and note
whether the same root cause applies.

Respond in {language}. Be specific and actionable. Every recommendation
must include the exact command or configuration change needed.
```

---

### Stage 4: Knowledge Base / 지식 베이스

**New file**: `src/lib/alert-knowledge.ts`
**Storage**: `data/alert-diagnosis/{YYYY-MM}/{incidentId}.json`

Every completed diagnosis is stored as a searchable knowledge entry:

```typescript
interface DiagnosisRecord {
  incidentId: string;
  timestamp: string;
  alerts: AlertEvent[];
  severity: 'critical' | 'warning' | 'info';
  affectedServices: string[];
  affectedResources: string[];
  rootCause: string;            // one-line summary
  rootCauseCategory: string;    // 'deployment' | 'capacity' | 'configuration' |
                                // 'dependency' | 'security' | 'infrastructure' | 'unknown'
  confidence: 'high' | 'medium' | 'low';
  diagnosisMarkdown: string;    // full AI analysis text
  remediationTaken?: string;    // user feedback on what was actually done
  resolvedAt?: string;
  wasHelpful?: boolean;         // user feedback
  investigationSources: string[];
  processingTimeMs: number;
}
```

**Knowledge Retrieval**: When a new incident arrives, search past records by:
- Matching `alertName` (exact or fuzzy)
- Matching `affectedServices` (set intersection)
- Matching `rootCauseCategory`
- Matching `labels` similarity (Jaccard index on key-value pairs)

Top 3 matches are included in the Bedrock analysis prompt as "Similar Past Incidents" context.

**Monthly Summaries**: Automated monthly aggregation of:
- Total incidents by severity
- Top root cause categories
- Mean time to diagnosis (from alert to analysis complete)
- Recurring alerts (same alert firing 3+ times)
- Services with most incidents

---

### Stage 5: Dispatch / 결과 전달

#### Slack Integration

**New file**: `src/lib/slack-notification.ts`

Supports two modes:
- **Incoming Webhook** (simple): Single channel, minimal setup
- **Bot Token** (recommended): Multi-channel, rich formatting, thread updates, reactions

**Block Kit Message Format** (for Slack Bot):

```
┌──────────────────────────────────────────┐
│ :rotating_light: Incident #INC-20260414-001           │
│ [CRITICAL] High HTTP 5xx Error Rate      │
├──────────────────────────────────────────┤
│ Affected: payment-service (prod)         │
│ Alerts: 3 correlated alerts              │
│ Duration: 12m (still firing)             │
├──────────────────────────────────────────┤
│ Root Cause (HIGH confidence):            │
│ Deployment v2.4.1 rolled out at 14:32    │
│ introduced a null pointer exception in   │
│ PaymentProcessor.validate(). Error rate  │
│ spiked from 0.1% to 23% within 2 min.   │
├──────────────────────────────────────────┤
│ Remediation:                             │
│ kubectl rollout undo deployment/         │
│   payment-service -n prod                │
├──────────────────────────────────────────┤
│ [View in Dashboard] [Full Diagnosis]     │
│ [Mark Resolved] [Was this helpful?]      │
└──────────────────────────────────────────┘
```

**Severity-based Channel Routing**:

| Severity | Default Channel | Behavior |
|----------|----------------|----------|
| critical | `#ops-critical` | Immediate post + thread with full diagnosis |
| warning | `#ops-alerts` | Summary post + link to dashboard |
| info | `#ops-general` | Compact notification only |

**Thread-based Updates**: When a resolved alert arrives for an active incident, post a follow-up in the thread:
```
:white_check_mark: Alert resolved after 23m
Root cause confirmed: deployment rollback resolved the issue
```

#### SNS Email (existing infrastructure)

Create `notifyAlertDiagnosis()` following the `notifyReportCompleted()` pattern:
- Subject: `[AWSops] {severity} Alert Diagnosis -- {alertName}`
- Body: Plain text summary + dashboard link

#### Dashboard Notification

Real-time notification to the dashboard via:
- Store in `data/alert-diagnosis/active.json` (active incidents list)
- Dashboard polls or receives via existing SSE pattern
- Alert icon badge in the header with incident count

---

### Stage 6: SQS Integration (Primary Path) / SQS 연동 (주요 경로)

This is the **primary ingestion path** for CloudWatch Alarms and other AWS-native alert sources: CloudWatch Alarm → SNS Topic → SQS Queue → AWSops

이것이 CloudWatch Alarm 및 기타 AWS 네이티브 알림 소스의 **주요 수집 경로**: CloudWatch Alarm → SNS Topic → SQS Queue → AWSops

**CDK Infrastructure** (`infra-cdk/lib/awsops-stack.ts`):

```typescript
// Dead Letter Queue — messages that fail processing 3 times
const alertDlq = new sqs.Queue(this, 'AlertDLQ', {
  queueName: 'awsops-alert-dlq',
  retentionPeriod: cdk.Duration.days(14),
});

// Main alert queue
const alertQueue = new sqs.Queue(this, 'AlertQueue', {
  queueName: 'awsops-alert-queue',
  visibilityTimeout: cdk.Duration.seconds(120),
  retentionPeriod: cdk.Duration.days(4),
  deadLetterQueue: { queue: alertDlq, maxReceiveCount: 3 },
});

// SNS Topic — CloudWatch Alarms publish here
const alertTopic = new sns.Topic(this, 'AlertTopic', {
  topicName: 'awsops-alert-topic',
});

// SNS → SQS subscription (automatic)
alertTopic.addSubscription(new subs.SqsSubscription(alertQueue));

// EC2 IAM permissions to poll SQS
ec2Role.addToPolicy(new iam.PolicyStatement({
  sid: 'SQSAlertPoller',
  actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
  resources: [alertQueue.queueArn, alertDlq.queueArn],
}));
```

**Application Poller** (`src/lib/alert-sqs-poller.ts`):

Follows the `cache-warmer.ts` / `report-scheduler.ts` background task pattern:

```typescript
// Lazy-init on first API request
let pollerStarted = false;
let isPolling = false;

export function ensureAlertPollerStarted() {
  if (pollerStarted) return;
  pollerStarted = true;
  startAlertPoller();
}

function startAlertPoller() {
  // Initial poll after 15s delay
  setTimeout(() => pollOnce(), 15_000);
  // Then every 30 seconds
  setInterval(() => pollOnce(), 30_000);
}

async function pollOnce() {
  if (isPolling) return; // guard against concurrent polls
  isPolling = true;
  try {
    // SQS ReceiveMessage (max 10, long polling 5s, visibility 120s)
    // For each message: unwrap SNS envelope → normalize → correlation engine → delete on success
    // Failed messages: don't delete — SQS returns them after visibility timeout → DLQ after 3 failures
  } finally {
    isPolling = false;
  }
}
```

**DLQ**: Messages that fail processing 3 times move to `awsops-alert-dlq` (14-day retention). Monitor DLQ depth via CloudWatch `ApproximateNumberOfMessagesVisible` metric.

**Networking**: EC2 accesses SQS outbound via existing NAT Gateway (or VPC Endpoint for SQS if configured). No inbound networking changes required.

---

### Stage 7: Configuration / 설정

**AppConfig additions** (`src/lib/app-config.ts`):

```typescript
interface AlertDiagnosisConfig {
  enabled: boolean;
  
  // Webhook security
  sources: {
    cloudwatch?: { enabled: boolean; snsSubscriptionArn?: string };
    alertmanager?: { enabled: boolean; secret?: string };
    grafana?: { enabled: boolean; secret?: string };
    sqs?: { enabled: boolean; queueUrl?: string; region?: string };
    generic?: { enabled: boolean; secret?: string };
  };
  
  // Correlation
  correlationWindowSeconds: number;     // default: 30
  deduplicationWindowMinutes: number;   // default: 15
  cooldownMinutes: number;              // default: 5
  maxConcurrentInvestigations: number;  // default: 3
  
  // Investigation
  investigationTimeoutSeconds: number;  // default: 120
  includeChangeDetection: boolean;      // default: true
  knowledgeBaseEnabled: boolean;        // default: true
  
  // Severity filter
  minimumSeverity: 'critical' | 'warning' | 'info'; // default: 'warning'
}

interface SlackConfig {
  enabled: boolean;
  method: 'webhook' | 'bot';
  webhookUrl?: string;
  botToken?: string;
  defaultChannel: string;              // e.g., '#ops-alerts'
  channelMapping?: {
    critical?: string;
    warning?: string;
    info?: string;
  };
  threadUpdates: boolean;              // default: true
}
```

Added to `AppConfig`:
```typescript
interface AppConfig {
  // ... existing fields ...
  alertDiagnosis?: AlertDiagnosisConfig;
  slack?: SlackConfig;
}
```

---

### Stage 8: Settings UI / 설정 UI

Add a new **Alert & Notifications** page (`src/app/alert-settings/page.tsx`) or extend the existing Accounts page:

**Section 1: Alert Sources**
- Toggle per source (CloudWatch, Alertmanager, Grafana, SQS, Generic)
- Secret/Token input per source
- Webhook URL display (copy-to-clipboard) with setup instructions
- SQS Queue URL input
- "Test Webhook" button per source

**Section 2: Slack Integration**
- Method toggle (Incoming Webhook vs Bot Token)
- Webhook URL or Bot Token input
- Default channel input
- Severity → Channel mapping (3 rows)
- Thread updates toggle
- "Test Slack Connection" button

**Section 3: Investigation Settings**
- Minimum severity filter (dropdown)
- Correlation window (slider: 10-120 seconds)
- Deduplication window (slider: 5-60 minutes)
- Cooldown period (slider: 1-30 minutes)
- Max concurrent investigations (1-5)
- Include change detection (toggle)
- Knowledge base enabled (toggle)

**Section 4: Alert History** (read-only dashboard)
- Recent incidents list with severity badges
- Expandable diagnosis results
- "Was this helpful?" feedback buttons
- Statistics: total incidents, avg diagnosis time, top services

---

## Implementation Plan / 구현 계획

### Phase 1: Foundation (Core Pipeline) / 기반

| # | File | Description |
|---|------|-------------|
| 1 | `src/lib/alert-types.ts` | AlertEvent, Incident, DiagnosisResult interfaces + per-source normalizers |
| 2 | `src/lib/alert-correlation.ts` | Correlation engine: time window, service, resource matching + dedup + severity escalation |
| 3 | `src/lib/alert-diagnosis.ts` | Investigation orchestrator: strategy selection, parallel collector/datasource execution, change detection, Bedrock analysis |
| 4 | `src/app/api/alert-webhook/route.ts` | POST endpoint with source detection, HMAC auth, rate limiting, SNS confirmation |
| 5 | `src/lib/app-config.ts` | Add `alertDiagnosis` and `slack` to AppConfig interface |

### Phase 2: Dispatch (Slack + SNS) / 전달

| # | File | Description |
|---|------|-------------|
| 6 | `src/lib/slack-notification.ts` | Slack Web API client: Block Kit message builder, channel routing, thread updates |
| 7 | `src/lib/sns-notification.ts` | Add `notifyAlertDiagnosis()` function following existing patterns |

### Phase 3: Knowledge + Storage / 지식 베이스 + 저장

| # | File | Description |
|---|------|-------------|
| 8 | `src/lib/alert-knowledge.ts` | Knowledge base: store diagnosis records, similarity search, monthly summaries |
| 9 | `data/alert-diagnosis/` | Storage directory for incident records |

### Phase 4: SQS + Background Polling / SQS + 백그라운드 폴링

| # | File | Description |
|---|------|-------------|
| 10 | `src/lib/alert-sqs-poller.ts` | Background SQS poller (cache-warmer pattern: lazy-init, guard, error isolation) |
| 11 | CDK: `infra-cdk/lib/awsops-stack.ts` | SQS queue + DLQ + IAM permissions (optional) |

### Phase 5: Settings UI / 설정 UI

| # | File | Description |
|---|------|-------------|
| 12 | `src/app/alert-settings/page.tsx` | Alert source config + Slack config + investigation params + alert history |
| 13 | `src/components/layout/Sidebar.tsx` | Add Alert Settings nav item |

### Phase 6: Dashboard Integration / 대시보드 연동

| # | File | Description |
|---|------|-------------|
| 14 | `src/components/layout/Header.tsx` | Active incident badge/indicator |
| 15 | `src/app/page.tsx` | Dashboard home: recent incidents summary card |

---

## Files to Create / 생성할 파일

| File | Lines (est.) | Description |
|------|-------------|-------------|
| `src/lib/alert-types.ts` | ~120 | Interfaces + 5 normalizer functions |
| `src/lib/alert-correlation.ts` | ~200 | Correlation engine + incident manager |
| `src/lib/alert-diagnosis.ts` | ~350 | Investigation orchestrator + strategy selection + Bedrock prompt |
| `src/lib/alert-knowledge.ts` | ~180 | Knowledge base CRUD + similarity search |
| `src/lib/slack-notification.ts` | ~250 | Slack Web API + Block Kit builder |
| `src/lib/alert-sqs-poller.ts` | ~100 | Background SQS poller |
| `src/app/api/alert-webhook/route.ts` | ~200 | Webhook endpoint |
| `src/app/alert-settings/page.tsx` | ~600 | Settings + history UI |

## Files to Modify / 수정할 파일

| File | Change |
|------|--------|
| `src/lib/app-config.ts` | Add `AlertDiagnosisConfig`, `SlackConfig` interfaces to `AppConfig` |
| `src/lib/sns-notification.ts` | Add `notifyAlertDiagnosis()` |
| `src/lib/collectors/incident.ts` | Add optional `alertContext` parameter for focused collection |
| `src/components/layout/Sidebar.tsx` | Add Alert Settings nav item |
| `src/components/layout/Header.tsx` | Add active incident indicator |
| `src/app/page.tsx` | Add recent incidents card |
| `CLAUDE.md` | Update stats, add alert-diagnosis to key files |

---

## Consequences / 결과

### Positive / 긍정적
- **MTTR reduction**: Automated root cause analysis within 60-90 seconds of alert firing, vs 15-30 minutes of manual investigation
- **Alert correlation**: Related alerts are grouped into incidents, eliminating redundant investigation. Teams see one diagnosis instead of N independent alerts
- **Knowledge accumulation**: Every incident diagnosis is stored and searchable. Recurring issues are flagged with "same root cause as INC-20260312-003"
- **Change correlation**: Automatic detection of "deployment 12 minutes before alert" -- the single most common root cause pattern
- **Maximum reuse**: Leverages all 7 existing collectors, 125 MCP tools, 7 datasource types, and Bedrock infrastructure. Estimated 70%+ of investigation code is reused
- **Multi-channel**: Slack (rich Block Kit), SNS email, dashboard -- operations teams get results wherever they work
- **Extensible**: New alert sources require only a normalizer function (~30 lines). New investigation strategies are declarative (add to decision matrix)

### Post-acceptance deviations / 채택 후 변경사항
- **Analysis model: Sonnet 4.6 instead of Opus 4.6**. Commit `ba03173` switched `alert-diagnosis.ts` to `global.anthropic.claude-sonnet-4-6` (ap-northeast-2 regional endpoint) to reduce per-incident cost by ~5x and avoid cross-region (us-east-1) latency. Quality tradeoff accepted for automated pipeline — on-demand deep investigation in AI chat still uses Opus via AgentCore.
- **분석 모델: Opus 4.6 → Sonnet 4.6 변경**. 커밋 `ba03173`에서 `alert-diagnosis.ts`가 `global.anthropic.claude-sonnet-4-6`로 교체됨(ap-northeast-2 리전 엔드포인트). 인시던트당 비용 약 5배 절감 + us-east-1 크로스 리전 지연 회피. AI 채팅의 on-demand 심층 조사는 여전히 AgentCore 경유 Opus 사용.

### Negative / 부정적
- **In-process resource sharing**: Background investigations share CPU/memory with the dashboard. Mitigated by `maxConcurrentInvestigations` (default 3) and `cooldownMinutes`
- **Bedrock cost**: Each investigation invokes Bedrock Opus with 4K-8K input tokens. At ~$15/M input tokens, 100 incidents/month costs ~$6-12. Manageable but should be monitored
- **Secret management**: Slack bot tokens and webhook secrets stored in `data/config.json` (plaintext). Future enhancement: migrate to AWS Secrets Manager
- **Webhook security**: Public endpoint increases attack surface. Mitigated by HMAC verification, rate limiting, and replay protection, but requires careful monitoring
- **Alert storm**: A cascade failure could generate hundreds of alerts. Mitigated by correlation window, dedup, cooldown, and max concurrent investigations, but may still cause delayed diagnosis for legitimate new incidents during the storm
- **False positives**: AI diagnosis may identify incorrect root causes, especially with incomplete data. Confidence levels (HIGH/MEDIUM/LOW) and the "Was this helpful?" feedback loop help calibrate over time

---

## Verification / 검증 방법

### Manual Testing
1. Send a test CloudWatch alarm via SNS → verify webhook receives and normalizes correctly
2. Send 3 related Alertmanager alerts within 10 seconds → verify correlation groups them
3. Trigger an actual CloudWatch alarm (e.g., CPU stress test on EC2) → verify full pipeline:
   - Alert received → correlated → investigated → Slack message delivered → stored in knowledge base
4. Send a resolved alert → verify Slack thread update
5. Verify dedup: send same alert twice within 15 minutes → only one diagnosis runs

### Integration Testing
1. Disable Prometheus datasource → verify investigation degrades gracefully (uses only Steampipe + CloudWatch)
2. Verify Slack channel routing: critical → `#ops-critical`, warning → `#ops-alerts`
3. Verify knowledge base search: trigger same alert twice → second diagnosis references the first

### Performance Testing
1. Verify investigation completes within 120 seconds for a typical alert
2. Verify 3 concurrent investigations don't degrade dashboard response time
3. Verify SQS poller processes backlog of 50 messages without resource exhaustion

---

## References / 참고 자료

### Internal
- [ADR-002](002-ai-hybrid-routing.md): AI Hybrid Routing (17-route architecture)
- [ADR-008](008-multi-account-support.md): Multi-Account Support (per-account context)
- `src/lib/collectors/incident.ts`: Existing multi-source incident collector
- `src/lib/collectors/types.ts`: Collector interface pattern
- `src/lib/datasource-client.ts`: 7-type datasource HTTP client
- `src/lib/cache-warmer.ts`: Background task pattern (lazy-init, guard, status tracking)
- `src/lib/report-scheduler.ts`: Interval-based scheduler pattern
- `src/lib/report-generator.ts`: Background report generation (fire-and-forget + polling)
- `src/lib/sns-notification.ts`: Existing notification infrastructure

### External
- [Prometheus Alertmanager Webhook](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config)
- [Grafana Alerting Webhook](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/)
- [CloudWatch Alarm SNS Format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)
- [Slack Block Kit Builder](https://app.slack.com/block-kit-builder)
- [Slack Web API](https://api.slack.com/web)
- [AWS SQS Developer Guide](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/)
