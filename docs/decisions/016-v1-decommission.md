# ADR-016: v1 레거시 폐기 / v1 Legacy Decommission

## Status / 상태
**Accepted.**

- **Owner 지시:** 오준석(Junseok Oh), 2026-07-09 — "v1 폐기하고 v2로 갈아치우려고해". 이는 ADR-005 autonomy freeze의 예외가 아니다(ADR-015와 달리) — **에이전트 자율 조치가 아니라 매 단계 사람이 지시·검토·승인하는 수동 폐기 작업**이며, BASELINE §0의 "안전한 운영 지속 고도화" 목표 아래의 일상적 제품 결정이다.
- **범위 갱신:** BASELINE §0/§1의 "v1은 별도 레거시, 이 문서의 제약 대상 아님" 문구는 v1이 **영구히** 손대지 않는 대상이라는 뜻이 아니었다 — 폐기 결정이 나면 당연히 대상이 된다. 이 ADR로 그 전제가 갱신된다.

## Context / 컨텍스트

v1(`src/`, CDK/EC2/Steampipe, `awsops.atomai.click`)은 v2 개발 기간 내내 "손대지 않는 레거시 프로덕션"으로 유지되어 왔다(root `CLAUDE.md` 헤더). v2(Terraform/Fargate/Aurora, `awsops-v2.atomai.click`)는 P1~P2가 GREEN이고 P3가 부분 진행 중이며, 실사용 가능한 상태로 프로덕션에 배포되어 있다.

v1은 계속 비용을 발생시킨다: EC2(m7g.2xlarge, 상시 실행, ~$235/월) + EBS 100GB + 공개 ALB + CloudFront + VPC 엔드포인트 3개. 병렬 운영의 실익이 소진되었다고 판단, 폐기를 결정한다.

폐기 전 확인한 사항(`docs/history/v1-v2-gap-audit-2026-07-09.md`):
- 2026-06-10 최초 감사의 missing 36건 중 12건은 이후 v2에 실제로 착지됨(ai-diagnosis, compliance, topology `@xyflow/react`, EOL 배지, EBS 스냅샷/ECS 서비스 인벤토리 수집, i18n, admin 그룹 게이트, opencost 등).
- 잔존 갭은 전부 **drop(의도적 수용)** 또는 **backlog(P3/P4 로드맵 기재)** — 폐기를 막는 차단 항목 없음.
- 유일한 실행 조건: **alert-webhook 외부 발신자 경로** — v1은 CloudWatch SNS/SQS(AWS 네이티브, poller가 EC2 인-프로세스) + Alertmanager/Grafana 직결 웹훅(외부 시스템이 v1 URL을 설정에 박아놓을 수 있음) 두 경로를 가진다. v2 `incidents/webhook`은 URL·인증 방식이 다르다 → Phase 1에서 실사 확인 필수.

## Decision / 결정

**v1을 Phase 0(본 ADR·문서 게이트) + Phase 1~5(실행 5단계)로 단계적 폐기하고, 도메인 `awsops.atomai.click`을 v2로 컷오버한다.**

1. **Phase 0(본 ADR)** — 갭 재검토 문서화 + 이 ADR + 런북(`docs/runbooks/v1-decommission.md`) 작성, BASELINE 갱신. 인프라 변경 전 게이트.
2. **Phase 1(데이터 확보)** — 기존 backfill 도구(`scripts/v2/backfill-v1.mjs`, 런북 `v1-to-v2-aurora-backfill.md`)로 inventory/cost/alert/event-scaling 이력을 v1이 살아있는 동안 최종 실행·검증. v1 Cognito 사용자를 v2 풀과 대조해 누락 사용자 재생성(비밀번호는 이관 불가 — 재설정). alert-webhook 외부 발신자 실사(위 Context §마지막 항).
   - **수용하는 데이터 손실**(명시): `data/config.json`(부서 ACL·브랜딩·자격증명), AI 대화 이력(`data/memory/`), `agentcore-stats.json`, `report-schedule.json`의 v1 항목 — backfill 대상 외로 원래부터 아웃오브스코프였으며, S3 아카이브도 하지 않는다(비용 대비 가치 낮음, owner 승인).
3. **Phase 2(도메인 컷오버)** — Terraform으로 `awsops.atomai.click`을 v2 CloudFront의 추가 별칭(SAN)으로 편입, Route53 레코드를 v2 소유로 이전(`terraform import`). v1 CloudFront에서는 별칭 제거. 기존 URL이 계속 동작하되 v2를 가리키게 됨.
4. **Phase 3(다크, 유예 시작)** — v1 EC2 **stop**(terminate 아님) + v1 CloudFront **disable**. 즉시 EC2 비용 절감(~$235/월). 1~2주 유예 관찰 — 문제 발생 시 EC2 start + CloudFront enable + 별칭 원복으로 롤백 가능.
5. **Phase 4(완전 삭제, 유예 후)** — `cdk destroy AwsopsStack`(또는 스택별 삭제) + 스택 밖 고아 리소스(`awsops-*-mcp` Lambda 18개 py3.12, `awsops-cognito-auth` Lambda@Edge, `awsops-deploy-*` S3) 개별 삭제. **spoke 계정의 `AWSopsReadOnlyRole`, 공유 VPC/hosted zone/CDKToolkit, v2 리소스 전체는 삭제 대상이 아님** — v2의 cross-account 조회 경로가 spoke 롤을 계속 사용한다.
6. **Phase 5(코드 정리, 별도 PR)** — Phase 4 완료 후 `src/`, `infra-cdk/`, v1 전용 스크립트(`scripts/0N-*.sh`), 루트의 v1 전용 빌드 설정(`next.config.mjs`/`tailwind.config.ts`/`postcss.config.mjs`/`.eslintrc.json`/`vitest.config.ts`/루트 `Dockerfile`)을 삭제하는 별도 PR. `agent/`는 부분 유지(`agent.py`, `agent/lambda/*.py`는 v2 `ai.tf`가 계속 참조) — v1 전용 부분(`agent/rca/`, `anthropic_loop.py` 등)만 대조 후 삭제.

**Phase 2까지 apply되면 v2가 v1의 유일한 살아있는 프로덕션 진입점이 되고, Phase 4가 끝나면 v1은 AWS 계정에서 완전히 사라진다.**

## Phase 1 실행 기록 (2026-07-09) / Phase 1 execution record

`docs/runbooks/v1-decommission.md` §1의 세 항목을 실행·확인했다:

- **1.1 backfill**: SSM으로 v1 `data/`(5.8MB) 추출 → dry-run → 실행. 결과: `inventory: scanned=26 inserted=693 errored=0`, `cost: scanned=24 inserted=24 errored=0`, `alert`/`scaling`은 v1에 데이터 자체가 없어 0. 에러 없음 — 완료.
- **1.2 Cognito 사용자 대조**: v1은 CFN 스택 밖(고아) `AWSops-UserPool`이 **2개** 존재(재배포로 중복 생성된 것으로 보임). 둘 다 사용자 **1명뿐**이며 이메일이 `admin@awsops.local`(플레이스홀더 테스트 계정)로 동일. v2 풀에도 **이미 동일한 `admin@awsops.local` 계정이 존재** → **실이관 대상 사용자 없음. 신규 생성/재설정 불필요.**
- **1.3 alert 경로 외부 발신자 확인**: 세 갈래로 확인 — (a) `awsops-alert-topic`의 구독자는 자체 SQS 큐 하나뿐, 외부 HTTP/email 구독 없음. (b) 이 토픽을 action으로 쓰는 CloudWatch Alarm **0건**. (c) v1 앱 실서버 로그(`/tmp/awsops-server.log`, 14,272줄, 서버 기동(5/31)부터 현재까지 전체 기간)에서 `alert-webhook` 문자열 매칭 **0건**. (d) `awsops-alert-queue`/`awsops-alert-dlq` 모두 큐 깊이 0. → **네 가지 독립 신호가 모두 "발신자 없음"으로 일치. 외부 웹훅(Alertmanager/Grafana)도 AWS 네이티브(CloudWatch→SNS→SQS) 경로도 현재 활성 발신자가 전혀 없다.** Phase 3(EC2 정지)로 안전하게 진행 가능 — 무음 유실 리스크로 표시했던 유일한 실행조건이 해소됨.

## Consequences / 결과

### Positive / 긍정
- EC2 상시 실행 비용(~$235/월) + EBS/ALB/VPCe 즉시 절감, 폐기 완료 시 v1 전체 인프라 비용 소멸.
- 병렬 운영으로 인한 이중 유지보수 부담(두 인증 시스템, 두 데이터 저장소, 두 배포 파이프라인) 해소.
- 기존 URL(`awsops.atomai.click`)이 유지되어 사용자 습관·북마크·외부 연동이 끊기지 않음.

### Negative / Trade-offs
- 명시된 데이터(부서 ACL·브랜딩·AI 대화이력·agentcore-stats·report-schedule)는 복구 불가능하게 손실 — owner가 사전 승인.
- v1 Cognito 사용자는 비밀번호 재설정 필요(이관 불가).
- alert-webhook 외부 발신자를 놓치면 무음 유실 위험 — Phase 1 실사로 완화하되 100% 보증은 아님.
- CloudFront 별칭 이동 구간에서 짧은 순단 가능성.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Operational Excellence**: 단계적(정지→유예→삭제) 폐기로 되돌릴 여지를 유예기간 동안 유지, 각 단계가 사람 지시·검토 하에 수행(ADR-005 자율 조치 아님).
- **Security**: v1 별도 Cognito 풀·인증 경로 제거로 공격면 축소. spoke 계정 `AWSopsReadOnlyRole`은 v2 경로 보존을 위해 명시적으로 삭제 대상 제외.
- **Reliability**: 도메인 컷오버는 alias 추가(SAN) + `create_before_destroy` 패턴으로 무중단 지향; 유예기간이 조기 문제 발견의 안전망.
- **Cost**: 즉시·확정적 절감(EC2 상시 실행 제거가 최대 비중).
- **Performance Efficiency**: 단일 스택(v2) 운영으로 배포·모니터링 대상 중복 제거.
- **Sustainability**: 유예기간 종료 후 EC2/EBS/ALB/VPCe 유휴 리소스 완전 반납으로 리소스 중복 소멸.
