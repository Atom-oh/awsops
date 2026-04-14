# ADR-010: Event-Driven Pre-Scaling System / 이벤트 기반 사전 스케일링 시스템

## Status: Proposed / 상태: 제안됨

## Context / 컨텍스트

AWSops is currently a read-only monitoring and analysis dashboard. It collects metrics and provides AI-powered recommendations, but it cannot take any infrastructure mutation actions. When large-scale events are anticipated (Black Friday, coupon campaigns, concert ticket sales), operations teams must manually pre-scale infrastructure across multiple AWS services -- EKS (via KEDA/HPA), Aurora DB (read replicas, ACU), MSK/Kafka (brokers, partitions), EC2/ASG (instance count), EBS (IOPS/throughput), and ALB (LCU capacity reservation). This manual process is error-prone, especially around warm-up timing (scaling everything at once causes cascading failures).

AWSops는 현재 읽기 전용 모니터링 및 분석 대시보드이다. 메트릭 수집과 AI 기반 권고사항을 제공하지만, 인프라 변경 작업을 수행할 수 없다. 대규모 이벤트(블랙프라이데이, 대규모 쿠폰 발행, 콘서트 티켓 오픈)가 예상될 때, 운영팀은 여러 AWS 서비스 -- EKS(KEDA/HPA), Aurora DB(읽기 복제본, ACU), MSK/Kafka(브로커, 파티션), EC2/ASG(인스턴스 수), EBS(IOPS/처리량), ALB(LCU 용량 예약) -- 에 대해 수동으로 사전 스케일링을 수행해야 한다. 이 수동 프로세스는 오류가 발생하기 쉬우며, 특히 웜업 타이밍 문제(한꺼번에 스케일링하면 연쇄 장애 발생)가 있다.

Key requirements / 핵심 요구사항:

- Register upcoming large-scale events with date, time, and expected pattern
- Reference past similar events to analyze historical metrics and derive scaling targets
- Generate pre-scaling plans with staged warm-up schedules (gradual ramp-up, not all-at-once)
- Execute scaling actions across: KEDA ScaledObjects, Aurora DB, MSK brokers, EC2/ASG, EBS volumes, ALB capacity (LCU pre-warming)
- Automatically restore original configuration after event completion
- Provide execution scripts and configuration guides for review before applying
- Track scaling status with rollback capability

## Options Considered / 검토한 옵션

### Option 1: Dashboard-Integrated Event Manager with Script Generation / 대시보드 통합 이벤트 매니저 + 스크립트 생성

Add a new `/event-scaling` page to AWSops. Users register events and specify patterns. The system analyzes historical metrics from Prometheus, CloudWatch, and Steampipe, then generates staged scaling scripts (bash/kubectl) and KEDA ScaledObject manifests. Users review and approve before execution. Execution runs via the EC2 instance's AWS CLI and kubectl.

AWSops에 `/event-scaling` 페이지를 추가한다. 사용자가 이벤트를 등록하고 패턴을 지정한다. 시스템이 Prometheus, CloudWatch, Steampipe의 이력 메트릭을 분석하여 단계별 스케일링 스크립트(bash/kubectl)와 KEDA ScaledObject 매니페스트를 생성한다. 사용자가 검토 및 승인 후 실행한다. EC2 인스턴스의 AWS CLI와 kubectl로 실행한다.

- **Pros / 장점**: Reuses existing datasource infrastructure (Prometheus, CloudWatch, Steampipe). Review-before-execute safety model. Single deployment (no additional infrastructure). Generates auditable scripts.
- **Cons / 단점**: EC2 instance needs elevated IAM permissions (write access to ASG, RDS, MSK, EBS). Script execution on EC2 requires careful error handling and timeout management.

### Option 2: Separate Scaling Service via Step Functions / Step Functions 별도 스케일링 서비스

Create an AWS Step Functions state machine that orchestrates scaling actions. AWSops generates the scaling plan and submits it to Step Functions. Each step (KEDA, Aurora, MSK, ASG, EBS) runs as a separate Lambda with targeted IAM roles.

AWS Step Functions 상태 머신을 생성하여 스케일링 작업을 오케스트레이션한다. AWSops가 스케일링 계획을 생성하고 Step Functions에 제출한다. 각 단계(KEDA, Aurora, MSK, ASG, EBS)는 개별 IAM 역할을 가진 Lambda로 실행한다.

- **Pros / 장점**: Fine-grained IAM per resource type. Built-in retry, error handling, and audit trail. Decoupled from dashboard process.
- **Cons / 단점**: Significant infrastructure addition (Step Functions, 5+ Lambda, IAM roles, CDK). Cannot use kubectl directly from Lambda (needs EKS access). High operational complexity for initial deployment.

### Option 3: GitOps-Based Scaling via ArgoCD / ArgoCD 기반 GitOps 스케일링

Generate scaling manifests (KEDA ScaledObjects, HPA patches) and push to a Git repository. ArgoCD applies them to the EKS cluster. AWS resource scaling (Aurora, MSK, ASG) uses Terraform applied via CI/CD.

스케일링 매니페스트(KEDA ScaledObject, HPA 패치)를 생성하여 Git 리포지토리에 푸시한다. ArgoCD가 EKS 클러스터에 적용한다. AWS 리소스 스케일링(Aurora, MSK, ASG)은 CI/CD를 통한 Terraform으로 적용한다.

- **Pros / 장점**: Full audit trail via Git history. Declarative approach. Rollback via Git revert.
- **Cons / 단점**: Requires ArgoCD and Terraform pipeline setup. Multiple systems to coordinate. Slow feedback loop (Git push -> CI -> apply). Overkill for time-sensitive event preparation.

## Decision / 결정

**Option 1: Dashboard-Integrated Event Manager with Script Generation**

This approach aligns with AWSops's existing architecture (Next.js + EC2) and provides the fastest path to a working system. The review-before-execute model is critical for safety since this is the first write/mutate feature in the dashboard.

이 접근법은 AWSops의 기존 아키텍처(Next.js + EC2)와 부합하며 가장 빠르게 작동하는 시스템을 구축할 수 있다. 대시보드의 첫 번째 쓰기/변경 기능이므로, 검토-후-실행 모델이 안전성을 위해 필수적이다.

### 1. Data Model / 데이터 모델

```typescript
interface ScalingEvent {
  eventId: string;                    // UUID
  name: string;                       // e.g., "Black Friday 2026"
  description?: string;
  eventStart: string;                 // ISO 8601
  eventEnd: string;                   // ISO 8601
  warmUpStart: string;                // Scaling ramp-up begins (e.g., eventStart - 2h)
  status: 'planned' | 'warming' | 'active' | 'cooldown' | 'completed' | 'cancelled';
  pattern: EventPattern;
  referenceEvents?: ReferenceEvent[]; // Past similar events for metric analysis
  scalingPlan?: ScalingPlan;          // AI-generated plan after metric analysis
  accountId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface EventPattern {
  type: 'flash-sale' | 'sustained-peak' | 'gradual-ramp' | 'ticket-drop';
  expectedPeakMultiplier: number;     // e.g., 10x normal traffic
  durationMinutes: number;            // Expected peak duration
  rampUpMinutes: number;              // Warm-up window
  customMetrics?: string[];           // Specific metrics to watch
}

interface ReferenceEvent {
  name: string;                       // e.g., "Black Friday 2025"
  date: string;                       // ISO 8601
  metricsSnapshot?: MetricsSnapshot;  // Auto-collected from Prometheus/CloudWatch
}

interface ScalingPlan {
  phases: ScalingPhase[];             // Staged warm-up plan
  estimatedCost?: number;
  rollbackPlan: RollbackConfig;
  generatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

interface ScalingPhase {
  phaseNumber: number;                // 1, 2, 3, ...
  scheduledAt: string;                // When this phase executes
  targets: ScalingTarget[];
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';
}

interface ScalingTarget {
  resourceType: 'keda' | 'hpa' | 'aurora-replica' | 'aurora-acu' |
                'msk-broker' | 'msk-partition' | 'asg' | 'ec2' | 'ebs-iops' |
                'alb-capacity';
  resourceId: string;                 // ARN, name, or identifier
  currentValue: number;
  targetValue: number;
  script: string;                     // Generated bash/kubectl command
  executed?: boolean;
  executedAt?: string;
}

interface RollbackConfig {
  autoRollback: boolean;              // Auto-restore after eventEnd
  cooldownMinutes: number;            // Wait time after event before rollback
  originalValues: Record<string, number>; // Snapshot of pre-scaling values
}
```

### 2. Warm-Up Strategy / 웜업 전략

Warm-up is the most critical aspect. Scaling everything at once causes:
- Aurora connection pool exhaustion during failover
- KEDA/HPA thrashing from sudden metric changes
- EBS volume throttling during IOPS reconfiguration
- ASG launch failures from EC2 capacity constraints

웜업은 가장 핵심적인 부분이다. 한꺼번에 스케일링하면 다음 문제가 발생한다:
- Aurora 장애 조치 중 연결 풀 고갈
- 급격한 메트릭 변화로 인한 KEDA/HPA 스래싱
- IOPS 재구성 중 EBS 볼륨 스로틀링
- EC2 용량 제한으로 인한 ASG 시작 실패

The system generates a multi-phase warm-up plan:

```
Phase 1 (T-4h): EBS IOPS increase + Aurora read replica creation + ALB pre-warming (capacity reservation)
Phase 2 (T-2h): MSK broker scaling + ASG min/desired increase (50%)
Phase 3 (T-1h): ASG ramp to target + KEDA ScaledObject update (minReplicaCount)
Phase 4 (T-30m): Final health check + KEDA trigger threshold adjustment + ALB LCU verification
Phase 5 (T+end+30m): Cooldown monitoring
Phase 6 (T+end+2h): Rollback to original values (reverse order, ALB capacity release)
```

Each phase waits for the previous to stabilize before proceeding. Phase execution is tracked in the event metadata.

### 3. Historical Metrics Analysis / 이력 메트릭 분석

When a user registers a reference event (e.g., "Black Friday 2025, 2025-11-28 09:00 KST"), the system:

1. Queries CloudWatch for that time window: CPU, memory, network, request count, error rate, latency (EC2, RDS, MSK, ELB)
2. Queries Prometheus (if available) for the same window: pod CPU/memory, request rate, queue depth
3. Queries Steampipe for resource state at that time: ASG sizes, RDS instance types, MSK broker count
4. Feeds all metrics to Bedrock to generate a scaling recommendation with specific target values

사용자가 참조 이벤트(예: "블랙프라이데이 2025, 2025-11-28 09:00 KST")를 등록하면:

1. CloudWatch에서 해당 시간대 메트릭 조회: CPU, 메모리, 네트워크, 요청 수, 에러율, 지연시간
2. Prometheus(가용 시) 동일 시간대 조회: Pod CPU/메모리, 요청률, 큐 깊이
3. Steampipe로 해당 시점 리소스 상태 조회: ASG 크기, RDS 인스턴스 타입, MSK 브로커 수
4. 모든 메트릭을 Bedrock에 전달하여 구체적 목표 값이 포함된 스케일링 권고 생성

### 4. API Layer / API 계층

New API route: `src/app/api/event-scaling/route.ts`

| Method | Action | Description |
|--------|--------|-------------|
| GET | `list` | List all registered events |
| GET | `detail` | Get event detail with scaling plan |
| GET | `metrics` | Fetch historical metrics for reference event |
| POST | `create` | Register new event |
| POST | `analyze` | Trigger AI analysis and plan generation |
| POST | `approve` | Approve scaling plan |
| POST | `execute-phase` | Execute a specific scaling phase |
| POST | `rollback` | Trigger manual rollback |
| PUT | `update` | Update event details |
| DELETE | `cancel` | Cancel event and rollback if active |

### 5. Frontend / 프론트엔드

New page: `src/app/event-scaling/page.tsx`

- Event list with status indicators (planned, warming, active, cooldown, completed)
- Event registration form: name, date/time, pattern selector, reference events
- Scaling plan visualization: timeline view with phased warm-up steps
- Phase execution controls: approve, execute, skip, rollback per phase
- Historical metrics charts from reference events
- Script preview panel: view generated bash/kubectl before execution

Sidebar addition: Add "Event Scaling" under a new "Operations" group in `Sidebar.tsx`.

### 6. KEDA Integration / KEDA 통합

New setup script: `scripts/13-setup-keda.sh`

- Install KEDA operator via Helm
- Configure KEDA to use existing Prometheus as metrics source
- Create default ScaledObject templates for common patterns

KEDA scaling approach:
- Modify `minReplicaCount` in ScaledObject for pre-warming (not `maxReplicaCount`)
- Use `cooldownPeriod` and `pollingInterval` adjustments for event mode
- Generate `kubectl apply -f` commands for ScaledObject patches

### 7. Security / 보안

This is the first write/mutate feature in AWSops. Required IAM additions to `awsops-ec2-role`:

```json
{
  "Effect": "Allow",
  "Action": [
    "autoscaling:UpdateAutoScalingGroup",
    "autoscaling:SetDesiredCapacity",
    "rds:CreateDBInstanceReadReplica",
    "rds:DeleteDBInstance",
    "rds:ModifyDBCluster",
    "kafka:UpdateBrokerCount",
    "kafka:UpdateBrokerStorage",
    "ec2:ModifyVolume",
    "ec2:DescribeVolumesModifications",
    "elasticloadbalancing:ModifyLoadBalancerAttributes",
    "elasticloadbalancing:ModifyTargetGroupAttributes",
    "elasticloadbalancing:DescribeLoadBalancers",
    "elasticloadbalancing:DescribeTargetGroups"
  ],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "aws:RequestedRegion": "ap-northeast-2" }
  }
}
```

Safety controls:
- Admin-only access (`adminEmails` config check)
- Approval required before execution (no auto-execute on registration)
- All scaling actions logged to `data/event-scaling/` with full audit trail
- Rollback configuration captured before any mutation
- Dry-run mode: generate scripts without executing

## Implementation Plan / 구현 계획

### Phase 1: Event Registration + Metrics Analysis
- Data model and config (`data/event-scaling/`)
- API route: create, list, detail, metrics
- Frontend: event list, registration form, reference event metrics charts
- Bedrock analysis for scaling recommendations

### Phase 2: Scaling Plan Generation + Script Export
- AI-generated multi-phase scaling plan
- Script generation for each resource type
- Plan visualization UI with timeline
- Export scripts as downloadable bash files

### Phase 3: Integrated Execution + Rollback
- KEDA setup script (`scripts/13-setup-keda.sh`)
- Phase-by-phase execution from dashboard
- Status tracking and health checks between phases
- Automatic rollback after event end
- CDK IAM policy updates

## Files to Create/Modify / 생성/수정 파일

| File | Action | Description |
|------|--------|-------------|
| `src/app/event-scaling/page.tsx` | Create | Event Scaling page |
| `src/app/api/event-scaling/route.ts` | Create | Event Scaling API (CRUD + execute) |
| `src/lib/event-scaling.ts` | Create | Event data model, storage, scaling logic |
| `src/lib/event-scaling-prompts.ts` | Create | Bedrock prompts for scaling analysis |
| `src/lib/event-scaling-scripts.ts` | Create | Script generator per resource type |
| `src/lib/queries/event-scaling.ts` | Create | CloudWatch/Steampipe queries for historical metrics |
| `scripts/13-setup-keda.sh` | Create | KEDA operator installation |
| `src/components/layout/Sidebar.tsx` | Modify | Add Event Scaling nav item |
| `src/lib/app-config.ts` | Modify | Add eventScaling config interface |
| `infra-cdk/lib/awsops-stack.ts` | Modify | Add write IAM permissions |

## Consequences / 영향

### Positive / 긍정적
- Eliminates manual pre-scaling work for large events, reducing human error
- Staged warm-up prevents cascading failures from simultaneous scaling
- Historical metrics analysis provides data-driven scaling targets instead of guesswork
- Audit trail and approval workflow ensure operational safety
- Reuses existing Prometheus, CloudWatch, and Steampipe infrastructure

### Negative / 부정적
- First write/mutate feature introduces elevated IAM permissions to the EC2 role
- Incorrect scaling targets could cause over-provisioning costs or under-provisioning outages
- KEDA dependency adds operational complexity to EKS clusters
- Rollback failures (e.g., Aurora replica deletion timeout) require manual intervention
- Script execution on EC2 creates a single point of failure for scaling operations

## References / 참고 자료

- [ADR-008: Multi-Account Support](./008-multi-account-support.md) -- Account-scoped scaling
- [ADR-009: Alert-Triggered AI Diagnosis](./009-alert-triggered-ai-diagnosis.md) -- Similar background worker pattern
- [KEDA Documentation](https://keda.sh/docs/) -- ScaledObject, TriggerAuthentication
- [Aurora Auto Scaling](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Integrating.AutoScaling.html) -- Read replica scaling
- [MSK Broker Scaling](https://docs.aws.amazon.com/msk/latest/developerguide/msk-update-broker-count.html) -- Broker count update
