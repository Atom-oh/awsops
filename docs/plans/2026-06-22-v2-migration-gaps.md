# V2 마이그레이션 미구현 항목 / V2 Migration Gaps (ADR-030)

작성일 / Date: 2026-06-22
기준 브랜치 / Branch: `claude/magical-pascal-CzqWG`
기준 ADR / Reference: [ADR-030 — ECS Fargate + Aurora App State + Dual-Tier ECR](../decisions/030-ecs-fargate-aurora-split.md)

---

## 1. 요약 / Summary

**V1 = 단일 EC2 (t4g.2xlarge) + 로컬 `data/*.json`**.
**V2 = ECS Fargate × 4 서비스 + Aurora Serverless v2 + 이중 ECR (Private dev / Public prod)**.

ADR-030은 3단계 이전을 정의한다. 현재 진행 상태:

| Phase | 범위 / Scope | 현재 / Current |
|-------|--------------|----------------|
| Phase 1 — Aurora 듀얼라이트 | 7개 JSON 소스 → Aurora 듀얼라이트, 7일 parity gate | **6/7 듀얼라이트 완료**, parity 게이트 미자동화 |
| Phase 2 — Fargate 컷오버 | web/jobs/alert-poller Fargate 이전, Service Connect, 인증 부착 | **dev 환경만 부분 실행**, prod 미시작 |
| Phase 3 — Steampipe & 배포 | Steampipe 별도 서비스화, EC2 빌드 폐기, Public ECR + cosign | **미시작** |

총 **31개 갭** 식별 (구현 13, 문서 5, 운영 13).

V1 = single EC2 (`t4g.2xlarge`) with local `data/*.json`.
V2 = 4 ECS Fargate services + Aurora Serverless v2 + Dual-tier ECR (Private dev / Public prod).
ADR-030 defines a three-phase migration. Today: **Phase 1 is 6/7 complete; Phase 2 has only a dev environment; Phase 3 has not started.**

---

## 2. 구현 완료 항목 / What V2 Has Today

ADR-030 채택(2026-05-27) 이후 머지된 변경.
Changes merged since ADR-030 was accepted (2026-05-27):

### Phase 1 — 데이터 계층 / Data layer
- ✅ `AwsopsDataStack` (`infra-cdk/lib/awsops-data-stack.ts`) — Aurora Serverless v2 PostgreSQL 15.5, 0.5–4 ACU, KMS-encrypted storage + secret, private subnets, app-SG-only ingress on 5432
- ✅ `infra-cdk/data/schema.sql` — 7개 테이블 (`inventory_snapshots`, `cost_snapshots`, `agentcore_memory`, `agentcore_stats`, `alert_diagnosis`, `event_scaling_plans`, `report_schedules`) + `schema_migrations` + `updated_at` 트리거. 멱등 (`CREATE TABLE IF NOT EXISTS`)
- ✅ `src/lib/db.ts` — Aurora pg Pool (DSN 또는 분리 env, TLS 검증, lazy init, health probe)
- ✅ `scripts/13-deploy-aurora.sh` — `deploy` / `schema` / `status` / `dsn` 서브커맨드
- ✅ Phase 1 듀얼라이트 라이터 **6/7**: `src/lib/db/{agentcore-stats,agentcore-memory,alert-diagnosis,cost,event-scaling,inventory}-writer.ts`. 모두 `isAuroraEnabled()` 가드 + `recordWrite/recordFailure` (`src/lib/db/drift.ts`)
- ✅ `/api/parity` 라우트 (`src/app/api/parity/route.ts`) — admin-only, 소스별 카운트 비교
- ✅ Vitest 유닛 테스트 (`tests/unit/{*-writer,db,db-drift,parity-route}.test.ts`)

### Phase 2 — Fargate dev 환경 / Fargate dev environment
- ✅ `AwsopsDevEcsStack` (`infra-cdk/lib/awsops-dev-ecs-stack.ts`) — Fargate ARM64, 2 vCPU / 4 GB, Next.js + Steampipe **사이드카** 단일 태스크
- ✅ Dev ALB + CloudFront + ACM (us-east-1) + Route53 alias → `awsops-dev.atomai.click`
- ✅ Dev ECR 리포지토리 `awsops-dev` (lifecycle: next 10 + steampipe 10)
- ✅ Aurora 연결 와이어링 — `AURORA_HOST/PORT/DB/SSLMODE` env + `AURORA_USER/PASSWORD` Secrets Manager 통합, CMK `kms:Decrypt` 부여
- ✅ Deploy 스크립트 `scripts/14-deploy-dev-ecs.sh` (build/roll/full/status) + `scripts/15-attach-dev-auth.sh` (Lambda@Edge 부착 래퍼)
- ✅ Steampipe 사이드카 헬스체크 (`pg_isready`) + 컨테이너 의존성 (`HEALTHY`)
- ✅ 배포 서킷 브레이커 + ECS Exec
- ✅ ALB SG = CloudFront prefix list만 허용 (V1과 동일 패턴)

---

## 3. 미구현 항목 / Gaps

우선순위 표기: 🔴 **P0** (컷오버 차단), 🟠 **P1** (운영 위험), 🟡 **P2** (잔여 개선).

### 3.1 Phase 1 — 듀얼라이트 잔여 / Remaining dual-write items

| # | 항목 / Item | 상태 / Status | 우선순위 |
|---|---|---|---|
| **G-01** | `report_schedules` Aurora 듀얼라이트 미구현 | `src/lib/report-scheduler.ts`의 `writeSchedule()`이 JSON에만 기록. `/api/parity` 응답에 `"6 of 7 sources wired. report_schedules lands in a follow-up commit."` 명시 | 🔴 P0 |
| **G-02** | 7-day parity gate 자동화 부재 | `/api/parity`는 호출 시점 비교만. ADR이 정의한 "7일 zero drift" 게이트를 측정·기록·승격하는 자동 절차 없음 (예: nightly CloudWatch alarm + drift 임계값) | 🟠 P1 |
| **G-03** | 듀얼라이트 → 단방향(Aurora-only) 전환 경로 부재 | 현재 모든 코드가 `try JSON; shadow Aurora`. JSON 소거(`fs.unlink`) 또는 read 컷오버 플래그 없음. Phase 1.5 작업 | 🟠 P1 |
| **G-04** | Aurora **read** 경로 미구현 | 모든 reader (`getStats`, `listEvents`, `countJsonDiagnoses`, `getConversations`, `countJsonInventoryDays`, `countJsonCostSnapshots`)가 여전히 JSON. 듀얼라이트는 데이터를 채울 뿐, 컨테이너 교체 시 상태가 살아나지 않음 | 🔴 P0 |

### 3.2 Phase 2 — Fargate 컷오버 잔여 / Fargate cutover remaining

| # | 항목 / Item | 상태 / Status | 우선순위 |
|---|---|---|---|
| **G-05** | **Prod** Fargate 스택 미존재 | `AwsopsDevEcsStack`만 존재. ADR이 정의한 `awsops-workload-stack` (prod web/steampipe/jobs/alert-poller 4 서비스 분리) 미작성. Prod 트래픽은 여전히 EC2 | 🔴 P0 |
| **G-06** | 4 서비스 분리 미실행 — Steampipe 사이드카 결합 | dev 태스크는 web+steampipe를 단일 task definition으로 묶음. ADR은 `awsops-web` / `awsops-steampipe` / `awsops-jobs` / `awsops-alert-poller` 4 Fargate 서비스 분리 명시. 분리되지 않으면 web 스케일 = steampipe 재시작 = 콜드 FDW | 🟠 P1 |
| **G-07** | Service Connect mesh 미구성 | ADR이 요구하는 `awsops-steampipe.awsops.local:9193` 내부 DNS 없음 (사이드카라 `127.0.0.1`로 도달). 4 서비스 분리 시 필수 | 🟠 P1 |
| **G-08** | dev CloudFront에 Lambda@Edge 인증 미부착 | `AwsopsDevEcsStack` 코드 주석에 명시: "Until an equivalent step runs for THIS distribution, the dev environment is publicly reachable." `15-attach-dev-auth.sh`가 있으나 _운영자가 명시적으로 실행_ 해야 함. CI/post-deploy hook으로 강제되지 않음 | 🔴 P0 |
| **G-09** | Aurora SG ↔ dev service SG 인그레스 수동 작업 | 순환 의존성 회피를 위해 `aws ec2 authorize-security-group-ingress`를 사람이 실행해야 함. CDK 외부 명시적 단계 — runbook 또는 별도 lifecycle 스크립트 없음 | 🟡 P2 |
| **G-10** | `awsops-jobs` 서비스 미존재 | 캐시 워머(`src/lib/cache-warmer.ts`)와 리포트 스케줄러(`src/lib/report-scheduler.ts`)는 Next.js 프로세스 내부에서 동작. ADR은 별도 `awsops-jobs` Fargate 태스크 (cron) 명시 | 🟠 P1 |
| **G-11** | `awsops-alert-poller` Fargate 서비스 미존재 | V1은 EC2 systemd 서비스(`alert-poller`)로 SQS 폴링. dev ECS 태스크에는 폴러 컨테이너 없음 — Slack/SNS alert 파이프라인이 dev에서 동작하지 않음 | 🟠 P1 |
| **G-12** | `data/config.json` 마운트 전략 미정 | ADR이 "ConfigMap/Secret로 마운트" 명시. 현재 dev 이미지는 빌드 시점에 파일을 굽거나 빈 상태로 출발 — 계정 변경 시 이미지 재빌드 필요. 운영용 마운트 메커니즘 없음 | 🟠 P1 |
| **G-13** | Task role IAM 광역 권한 | `ReadOnlyAccess` + `SecretsManagerReadOnly`. PR #26 리뷰가 "scope this to just the AWS services Steampipe actually queries" deferred MAJOR로 기록. 멀티 어카운트 STS AssumeRole 권한도 미포함 | 🟠 P1 |
| **G-14** | 멀티 어카운트 cross-account assume 미동작 | dev task role에 `sts:AssumeRole` 정책 없음. V1은 EC2 인스턴스 프로파일이 Target 계정 역할 가정. V2 dev에서 12-setup-multi-account.sh의 효과가 사라짐 | 🟠 P1 |

### 3.3 Phase 3 — 빌드/배포 분리 / Build & distribution

| # | 항목 / Item | 상태 / Status | 우선순위 |
|---|---|---|---|
| **G-15** | EC2 빌드 호스트 미폐기 | Step 6a (`scripts/06a-setup-agentcore-runtime.sh`)이 여전히 EC2에서 `docker buildx`. ADR 동기 자체 ("빌드와 런타임이 같은 호스트에서 충돌") 해결 안 됨 | 🟠 P1 |
| **G-16** | CodeBuild / GitHub Actions 빌드 파이프라인 부재 | 모든 빌드는 운영자가 EC2에서 수동 실행. `14-deploy-dev-ecs.sh`도 로컬 docker. CI 빌드 파이프라인 미구축 | 🟠 P1 |
| **G-17** | **Public ECR** 리포지토리 미생성 | `public.ecr.aws/awsops/*` 4개 리포지토리(`awsops-web`, `awsops-steampipe`, `awsops-jobs`, `awsops-alert-poller`) 미정의. 오픈소스 배포 채널 부재 | 🟡 P2 |
| **G-18** | `cosign` 서명 파이프라인 부재 | ADR이 prod 이미지 cosign 서명 + 시맨틱 버전 태그 명시. 서명 도구/KMS 키/검증 절차 미구축 | 🟡 P2 |
| **G-19** | Public ECR tag immutability 미설정 | 정책으로 강제되지 않음 — 동일 태그 재푸시 가능 → 공급망 무결성 위반 | 🟡 P2 |
| **G-20** | cosign 키 보관 결정 미완 | ADR "Open follow-up" — AWS KMS-backed vs 로컬 키 파일 결정 필요. Phase 3 진입 전 차단 항목 | 🟡 P2 |

### 3.4 운영 / Operational

| # | 항목 / Item | 상태 / Status | 우선순위 |
|---|---|---|---|
| **G-21** | Runbook **4종** 부재 | ADR "Open follow-ups"가 명시: Aurora failover, Fargate task replacement, Public ECR rollback, cosign key rotation. `docs/runbooks/` 검색 결과 0건 — Phase 3 컷오버 전 작성 필요 | 🟠 P1 |
| **G-22** | 비용 검증 미완 | ADR 추정 "+\$50–80/mo". 실제 워크로드 (web concurrency, Steampipe FDW pool size, Aurora ACU floor) 측정·검증 안 됨 | 🟡 P2 |
| **G-23** | Aurora 스키마 리뷰 미서명 | 7개 테이블 존재하나 ADR "finalize column types and indexes" 리뷰 마커 없음. 운영 진입 전 인덱스 선정 + JSONB 키 핫스팟 확인 필요 (특히 `payload` GIN 인덱스 미부여) | 🟡 P2 |
| **G-24** | Aurora PITR/백업 절차 미문서화 | RDS 기본 백업 윈도우는 켜져 있음(default 1 day). 별도 PITR 보관 기간, 복구 RTO/RPO, snapshot export 절차 미정의 | 🟠 P1 |
| **G-25** | `cache-warmer` Fargate 동작 검증 미완 | Next.js process-bound으로 동작. 컨테이너 1 태스크일 때는 OK이나 multi-task 스케일 시 중복 워밍. ADR이 `awsops-jobs`로 분리하라는 이유 | 🟡 P2 |
| **G-26** | OpenCost / EKS 통합 (Step 7) 검증 미완 | V1은 EC2 보안그룹에서 EKS 인그레스. dev Fargate 태스크가 OpenCost API에 도달 가능한지 (Pod IP/VPC 경로) 미검증 | 🟡 P2 |
| **G-27** | `powerpipe` (CIS 벤치마크) Fargate 미포함 | Step 1 (`01-install-base.sh`)이 EC2에 `powerpipe` 설치. dev Steampipe 사이드카 이미지에 `powerpipe` 바이너리 포함 여부 미확인 — `/api/benchmark`가 dev에서 동작하지 않을 가능성 | 🟠 P1 |
| **G-28** | EKS Access Entry / kubeconfig (Step 4) Fargate 미동작 | V1은 EC2 사용자 홈에 `~/.kube/config`. Fargate 태스크는 즉시 사라지는 컨테이너 — kubeconfig 영속화 + 매 시작 시 갱신 절차 부재 | 🟠 P1 |
| **G-29** | AgentCore Memory 이중 저장 정합성 | ADR-018은 365일 보관 명시. dev에서 `agentcore_memory` 테이블의 `expires_at` 컬럼은 존재하나 만료 TTL 청소(`DELETE WHERE expires_at < NOW()`) 잡 미정의 | 🟡 P2 |
| **G-30** | 로깅 보존 정책 미통일 | dev `/ecs/awsops-dev` CloudWatch Log Group = `ONE_MONTH`. ADR/prod 로그 보존 정책 미명시 | 🟡 P2 |
| **G-31** | Steampipe config 영속화 미해결 | ADR이 "config은 Secrets Manager 마운트" 명시. dev Steampipe 사이드카는 이미지에 굽는 방식 — 멀티 어카운트 연결 추가 시 이미지 재빌드 필요 | 🟠 P1 |

### 3.5 문서 동기화 / Documentation drift

ADR-030 작업 결과 다음 CLAUDE.md가 stale (V2 코드를 반영하지 않음):

| 파일 | Stale 부분 |
|------|------------|
| `CLAUDE.md` (root) | "API Routes 19개" — `/api/parity`가 추가되어 실제 20개. ADR 30개 → 31개 |
| `infra-cdk/CLAUDE.md` | 3 스택만 나열 (Awsops/Cognito/AgentCore). 실제 5 스택: + `AwsopsDataStack` + `AwsopsDevEcsStack` |
| `src/lib/CLAUDE.md` | `db.ts` 및 `db/` 서브디렉토리(7 라이터) 미수록 |
| `src/app/api/CLAUDE.md` | `parity/route.ts` 미수록 (Phase 1 parity 엔드포인트) |
| `scripts/CLAUDE.md` | Step 13/14/15 (Aurora deploy, dev ECS deploy, dev auth attach) 미수록 |
| `docs/CLAUDE.md` | "ADR 001~029" 표기 — 실제 001~030 (ADR-030 Accepted) |

V1 통계와 v2 구현이 어긋남: 루트 CLAUDE.md의 "Stats (v1.8.0)" 테이블은 Phase 1 작업이 반영되지 않음 (예: API 라우트, ADR 수).

---

## 4. 권장 작업 순서 / Recommended Sequencing

```
Phase 1 마무리 (단기, ~1주)
  ├─ G-01 report_schedules 듀얼라이트 + parity 노트 갱신
  ├─ G-02 7-day parity CloudWatch alarm 또는 nightly check 자동화
  ├─ G-23 Aurora 인덱스 리뷰 + payload GIN 결정
  └─ G-31 + G-12 config 마운트 전략 (Steampipe spc / app config.json)

Phase 2 준비 (중기, ~2-3주)
  ├─ G-04 Aurora read 경로 (1개 소스 시범 — `agentcore_stats`)
  ├─ G-08 dev CloudFront Lambda@Edge 자동 부착 (CDK hook 또는 deploy step 강제)
  ├─ G-13 Task role 최소 권한 + G-14 multi-account assume policy
  ├─ G-21 Runbook 4종 작성 (Aurora failover / Fargate replace / ECR rollback / cosign rotation)
  └─ G-24 Aurora PITR/백업 정책 결정

Phase 2 prod 컷오버 (장기)
  ├─ G-05 AwsopsWorkloadStack (prod) + G-06 4 서비스 분리
  ├─ G-07 Service Connect mesh
  ├─ G-10 awsops-jobs + G-11 awsops-alert-poller
  ├─ G-27 powerpipe 이미지화 + G-28 EKS kubeconfig 부트스트랩
  └─ G-29 agentcore_memory TTL 청소 잡

Phase 3 배포 (이후)
  ├─ G-15/G-16 CodeBuild/GHA 이미지 빌드
  ├─ G-17/G-18/G-19/G-20 Public ECR + cosign
  └─ EC2 빌드 호스트 폐기

문서 (수시)
  └─ 3.5 절의 6개 CLAUDE.md 동기화 (`/sync-docs` 스킬 활용)
```

---

## 5. 참고 / References

- ADR-030 — [030-ecs-fargate-aurora-split.md](../decisions/030-ecs-fargate-aurora-split.md)
- 듀얼라이트 진행 PR: #18 (agentcore_stats), #21 (event_scaling_plans), #22 (alert_diagnosis), #23 (agentcore_memory), #24 (inventory_snapshots), #25 (cost_snapshots)
- 인프라 PR: #14 (ADR-030 채택 + foundation), #16 (Phase 1 Aurora + db client), #26 (dev ECS scaffold), #27 (dev ECS 트래픽 라우팅)
- 코드:
  - 라이터 6개 — `src/lib/db/*-writer.ts`
  - 스키마 — `infra-cdk/data/schema.sql`
  - dev 스택 — `infra-cdk/lib/awsops-dev-ecs-stack.ts`
  - parity — `src/app/api/parity/route.ts`
  - 배포 — `scripts/13-deploy-aurora.sh`, `scripts/14-deploy-dev-ecs.sh`, `scripts/15-attach-dev-auth.sh`
