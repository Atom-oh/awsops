# ADR-012: SNS Notification Strategy / SNS 알림 전략

## Status: Accepted (2026-04-22) / 상태: 채택됨

## Context / 컨텍스트

AWSops delivers operational notifications (report completion, CIS benchmark results, alert diagnosis summaries) through two channels: Slack for real-time collaboration and SNS email for durable record. In the reverse direction, CloudWatch Alarms must be ingested into AWSops so the alert diagnosis pipeline (ADR-009) can act on them. Both directions share a single constraint: EC2 sits in a Private Subnet behind CloudFront + ALB, with Cognito Lambda@Edge rejecting any unauthenticated HTTP request. This ADR documents the delivery-layer decisions that ADR-009 references but does not specify in detail.

AWSops는 두 채널로 운영 알림(리포트 완료, CIS 벤치마크 결과, 알림 진단 요약)을 전달한다. 실시간 협업을 위한 Slack과 영구 기록을 위한 SNS 이메일이다. 역방향으로는 CloudWatch Alarm을 수집하여 ADR-009의 알림 진단 파이프라인이 처리할 수 있어야 한다. 양방향 모두 하나의 제약을 공유한다: EC2는 CloudFront + ALB 뒤의 Private Subnet에 위치하며, Cognito Lambda@Edge가 인증되지 않은 HTTP 요청을 모두 거부한다. 이 ADR은 ADR-009가 참조하지만 세부적으로 명시하지 않은 전달 계층의 결정을 문서화한다.

Three concrete sub-problems emerged during implementation:
1. CloudWatch Alarm SNS subscriptions cannot authenticate against Cognito Lambda@Edge.
2. SNS email clients render raw markdown (`**bold**`, `## heading`, `| table |`) as literal text, making Bedrock-generated analysis unreadable.
3. The SNS/SQS setup previously required a separate CDK deploy before the alert pipeline could be enabled, creating a multi-step operator playbook.

구현 중 구체적으로 세 가지 하위 문제가 드러났다:
1. CloudWatch Alarm의 SNS 구독은 Cognito Lambda@Edge에서 인증을 통과할 수 없다.
2. SNS 이메일 클라이언트는 마크다운 원문(`**bold**`, `## heading`, `| table |`)을 문자 그대로 렌더링하므로 Bedrock이 생성한 분석문이 가독성을 잃는다.
3. SNS/SQS 설정에는 기존에 별도 CDK 배포가 선행되어야 하여, 운영자가 두 단계의 절차를 밟아야 했다.

## Decision / 결정

### 1. Ingestion: SNS → SQS → EC2 Polling (not direct HTTP)

CloudWatch Alarm → SNS Topic → SQS Queue → `src/lib/alert-sqs-poller.ts` polling from EC2. The poller uses AWS IAM-authenticated outbound `ReceiveMessage` calls (30-second interval, 5-second long-poll, 120s visibility timeout). Messages that fail processing three times move to a dead-letter queue (`awsops-alert-dlq`, 14-day retention) rather than blocking the main queue.

CloudWatch Alarm → SNS Topic → SQS Queue → `src/lib/alert-sqs-poller.ts`가 EC2에서 폴링. 폴러는 AWS IAM 인증된 아웃바운드 `ReceiveMessage` 호출을 사용한다(30초 간격, 5초 롱폴, 120초 가시성 타임아웃). 3회 처리 실패 메시지는 메인 큐를 막는 대신 DLQ(`awsops-alert-dlq`, 14일 보관)로 이동한다.

### 2. Email Body: Strip Markdown Before SNS Publish

`src/lib/sns-notification.ts` defines a local `stripMarkdown()` helper, applied at `publishNotification()` time inside `notifyReportCompleted()` and `notifyAlertDiagnosis()`. It converts headings, bold/italic, inline code, blockquotes, horizontal rules, and pipe-tables into plain-text equivalents before the message crosses the SNS API boundary. Slack notifications continue to consume the original markdown via Block Kit in `src/lib/slack-notification.ts`.

`src/lib/sns-notification.ts`에 `stripMarkdown()` 헬퍼를 정의하고, `notifyReportCompleted()` 및 `notifyAlertDiagnosis()` 내부 `publishNotification()` 호출 직전에 적용한다. 헤딩, 볼드/이탤릭, 인라인 코드, 블록쿼트, 수평선, 파이프 테이블을 평문 등가물로 변환한 뒤 SNS API 경계를 넘긴다. Slack은 `src/lib/slack-notification.ts`의 Block Kit을 통해 여전히 원본 마크다운을 그대로 소비한다.

### 3. Setup: Auto-Provision SQS + DLQ + SNS Subscription

The Settings UI "자동 등록" action (handled in `src/app/api/steampipe/route.ts` `setup-alert-pipeline` sub-route, added by commit `34ac8d1`) idempotently creates the DLQ, the main queue, an SQS queue policy granting `sns:Publish`, and the SNS → SQS subscription. Running it twice is a no-op. CDK deploy is no longer a prerequisite.

설정 UI의 "자동 등록" 액션(커밋 `34ac8d1`에서 추가된 `src/app/api/steampipe/route.ts`의 `setup-alert-pipeline` 서브라우트에서 처리)은 DLQ, 메인 큐, `sns:Publish`를 허용하는 SQS 큐 정책, SNS → SQS 구독을 멱등적으로 생성한다. 두 번 실행해도 동작이 중복되지 않는다. CDK 배포는 더 이상 선행 조건이 아니다.

### 4. Dispatch Endpoint: `/api/notification`

`src/app/api/notification/route.ts` exposes `toggle`, `sync-emails`, and `test` actions. Send-time routing (Slack vs SNS, severity → channel) happens in the caller (`notifyAlertDiagnosis`, `notifyReportCompleted`) so each sender can tailor content per channel rather than producing one generic payload.

`src/app/api/notification/route.ts`는 `toggle`, `sync-emails`, `test` 액션을 노출한다. 발송 시점의 라우팅(Slack 대 SNS, 심각도 → 채널)은 호출자(`notifyAlertDiagnosis`, `notifyReportCompleted`)에서 일어나며, 하나의 범용 페이로드를 만드는 대신 채널별로 콘텐츠를 맞춘다.

## Rationale / 근거

- **SQS over direct SNS HTTP subscription**: Cognito Lambda@Edge authenticates every inbound HTTPS request to CloudFront. SNS HTTP delivery sends `SubscriptionConfirmation`/`Notification` without Cognito tokens, so it cannot reach EC2. SQS polling flips the direction — EC2 reaches out, no inbound surface exists, and AWS IAM replaces the webhook signature scheme entirely.
- **SQS over Lambda fan-out**: Adding a Lambda subscriber would introduce a second runtime, IAM role, and deploy target for a task that is already naturally co-located with the AWSops process. The poller reuses `cache-warmer.ts`'s lazy-init/isPolling-guard pattern.
- **Markdown stripping at send time, not at generation time**: Bedrock output must remain markdown because Slack, the dashboard, DOCX, and PDF all render it natively. Email is the only lossy consumer. Converting at send time keeps a single source of truth.
- **DLQ at `maxReceiveCount: 3`**: Poison messages (malformed SNS payloads, schema drift) would otherwise loop forever at the visibility timeout. Three attempts distinguishes transient AWS SDK errors from structural defects.
- **Auto-provision in the API route, not CDK-only**: Multi-account deployments add accounts at runtime via `data/config.json`. Requiring a CDK redeploy for each new account's alert pipeline would couple data-plane config to infrastructure-plane deployment. The idempotent provisioning path lets operators enable alerts without leaving the dashboard.

- **SQS를 직접 SNS HTTP 구독보다 선호**: Cognito Lambda@Edge는 CloudFront로 들어오는 모든 HTTPS 요청을 인증한다. SNS HTTP 전달은 Cognito 토큰 없이 `SubscriptionConfirmation`/`Notification`을 전송하므로 EC2에 도달할 수 없다. SQS 폴링은 방향을 뒤집는다 — EC2가 바깥으로 호출하고 인바운드 표면이 존재하지 않으며, AWS IAM이 웹훅 서명 체계 전체를 대체한다.
- **Lambda 팬아웃보다 SQS 직결**: Lambda 구독자를 추가하면 이미 AWSops 프로세스와 자연스럽게 공존하는 작업에 두 번째 런타임, IAM 역할, 배포 대상을 도입하게 된다. 폴러는 `cache-warmer.ts`의 lazy-init/isPolling-guard 패턴을 재사용한다.
- **생성 시점이 아닌 발송 시점의 마크다운 제거**: Bedrock 출력은 Slack, 대시보드, DOCX, PDF가 모두 네이티브로 렌더링하므로 마크다운으로 유지되어야 한다. 이메일만 유일한 손실 소비자다. 발송 시점 변환은 단일 진실 원본을 유지한다.
- **`maxReceiveCount: 3` DLQ**: 오염 메시지(깨진 SNS 페이로드, 스키마 드리프트)는 그렇지 않으면 가시성 타임아웃에서 무한 루프를 돈다. 3회 시도는 일시적 SDK 오류와 구조적 결함을 구분한다.
- **CDK-only가 아닌 API 라우트 내 자동 프로비저닝**: 멀티 어카운트 배포는 `data/config.json`을 통해 런타임에 계정을 추가한다. 계정마다 CDK 재배포를 요구하면 데이터 플레인 설정이 인프라 플레인 배포에 결합된다. 멱등 프로비저닝 경로는 운영자가 대시보드를 벗어나지 않고 알림을 활성화할 수 있게 한다.

## Consequences / 결과

### Positive / 긍정적
- **No public HTTP ingress required**: CloudWatch Alarm ingestion works with the existing Cognito-protected CloudFront without exceptions, punch-throughs, or per-source HMAC secrets.
- **Readable emails**: Operators receive clean plain-text summaries instead of raw markdown syntax. Table columns are padded for alignment and blockquotes indented.
- **Idempotent operator setup**: A single "자동 등록" click provisions SQS + DLQ + subscription; re-running is safe.
- **Channel-appropriate content**: Slack gets rich Block Kit with buttons and severity emoji; email gets a digest with dashboard deep-links.
- **Alert storm containment**: DLQ absorbs poison messages so a single malformed alert cannot block the queue.

- **공개 HTTP 인그레스 불필요**: CloudWatch Alarm 수집이 예외 처리, 우회, 소스별 HMAC 시크릿 없이 기존 Cognito 보호 CloudFront와 함께 동작한다.
- **읽을 수 있는 이메일**: 운영자는 마크다운 원문 대신 깔끔한 평문 요약을 수신한다. 테이블 컬럼은 정렬을 위해 패딩되고 블록쿼트는 들여쓰기된다.
- **멱등 운영자 설정**: 단일 "자동 등록" 클릭으로 SQS + DLQ + 구독이 프로비저닝되며 재실행도 안전하다.
- **채널별 적절한 콘텐츠**: Slack은 버튼과 심각도 이모지가 있는 풍부한 Block Kit을, 이메일은 대시보드 딥링크가 있는 다이제스트를 수신한다.
- **알림 폭주 봉쇄**: DLQ가 오염 메시지를 흡수하므로 단일 오류 알림이 큐를 막을 수 없다.

### Negative / 부정적
- **Polling latency**: SQS polling adds up to 30 seconds of ingestion latency vs a direct webhook. For critical alerts this is within the correlation-window budget (ADR-009 specifies a 30-second buffer anyway), but it is not zero.
- **DLQ triage gap**: DLQ messages require periodic manual inspection. There is no CloudWatch alarm on `ApproximateNumberOfMessagesVisible` for the DLQ yet — an operations runbook gap.
- **Markdown stripping is lossy**: Email readers lose formatting, links collapse to plain URLs, and code blocks lose monospace rendering. Users wanting rich formatting must read the dashboard or Slack.
- **Dual-format maintenance**: Every new sender must handle both Slack Block Kit and plaintext email variants in `notification/route.ts` and `sns-notification.ts`. Adding a new channel (e.g., Teams, PagerDuty) would compound this.

- **폴링 지연**: SQS 폴링은 직접 웹훅 대비 최대 30초의 수집 지연을 더한다. 크리티컬 알림의 경우 상관 분석 윈도우 예산 내에 있지만(ADR-009가 이미 30초 버퍼를 명시) 0은 아니다.
- **DLQ 선별 공백**: DLQ 메시지는 주기적 수동 확인이 필요하다. 아직 DLQ의 `ApproximateNumberOfMessagesVisible`에 대한 CloudWatch 알람이 없다 — 운영 런북의 공백.
- **마크다운 제거는 손실적**: 이메일 독자는 서식을 잃고, 링크는 평문 URL로 무너지며, 코드 블록은 고정폭 렌더링을 잃는다. 풍부한 서식을 원하는 사용자는 대시보드나 Slack을 봐야 한다.
- **이중 포맷 유지**: 새로운 발신자는 `notification/route.ts`와 `sns-notification.ts` 양쪽에서 Slack Block Kit과 평문 이메일 변형을 모두 처리해야 한다. 새 채널(Teams, PagerDuty 등) 추가는 이 부담을 가중시킨다.

### Trade-offs / 트레이드오프
- **IAM-auth vs HMAC-auth**: IAM auth for SQS is simpler (no shared secret rotation) but couples ingestion to AWS-only sources. VPC-internal webhook sources (Alertmanager, Grafana) still use HMAC per ADR-009, so the two schemes coexist.
- **Per-caller formatting vs generic dispatcher**: Keeping formatting in each sender (`notifyReportCompleted`, `notifyAlertDiagnosis`) duplicates lines-of-code but gives per-notification control. A generic dispatcher would have to encode every notification type's header/body/footer conventions as config, which proved harder to maintain than the duplication.
- **Auto-provision vs explicit CDK**: Auto-provisioning is faster for operators but means the same resources can be created outside CDK state, leading to potential drift. Mitigated by the idempotent create (it will adopt existing resources) and by CDK remaining the canonical path for host-account infrastructure.

- **IAM 인증 대 HMAC 인증**: SQS의 IAM 인증은 더 단순하지만(공유 시크릿 회전 불필요) 수집을 AWS 전용 소스에 결합시킨다. VPC 내부 웹훅 소스(Alertmanager, Grafana)는 ADR-009에 따라 여전히 HMAC을 사용하므로 두 체계가 공존한다.
- **호출자별 포맷 대 범용 디스패처**: 각 발신자(`notifyReportCompleted`, `notifyAlertDiagnosis`)에 포맷을 두면 코드 라인이 중복되지만 알림별 제어가 가능하다. 범용 디스패처는 모든 알림 유형의 헤더/본문/푸터 관례를 설정으로 인코딩해야 하며, 이는 중복보다 유지보수가 어려웠다.
- **자동 프로비저닝 대 명시적 CDK**: 자동 프로비저닝은 운영자에게 더 빠르지만 동일 리소스가 CDK 상태 바깥에서 생성될 수 있어 잠재적 드리프트를 의미한다. 멱등 생성(기존 리소스를 흡수)과 호스트 계정 인프라의 정본 경로로서 CDK를 유지함으로써 완화된다.

## References / 참고 자료

### Internal
- [ADR-009](009-alert-triggered-ai-diagnosis.md): Alert-Triggered AI Diagnosis (upstream pipeline — correlation, investigation, analysis)
- [ADR-008](008-multi-account-support.md): Multi-Account Support (per-account runtime config driving per-account SNS topics)
- `src/lib/sns-notification.ts`: SNS client wrapper, topic/subscription management, `stripMarkdown()`, `notifyAlertDiagnosis()`, `notifyReportCompleted()`
- `src/lib/alert-sqs-poller.ts`: Background SQS poller (30s interval, DLQ, lazy-init pattern from `cache-warmer.ts`)
- `src/app/api/notification/route.ts`: Dispatch endpoint (toggle / sync-emails / test)
- `src/app/api/steampipe/route.ts`: `setup-alert-pipeline` action — auto-provisions DLQ + queue + policy + SNS subscription (commit `34ac8d1`)
- Commit `257ae9b`: strip markdown from SNS email notifications
- Commit `34ac8d1`: auto-create SQS queue + DLQ + SNS subscription in setup-alert-pipeline

### External
- [Amazon SNS → SQS Subscription](https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html)
- [Amazon SQS Dead-Letter Queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [CloudWatch Alarm SNS Notification Format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)
- [Lambda@Edge Authentication Patterns](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-the-edge.html)
