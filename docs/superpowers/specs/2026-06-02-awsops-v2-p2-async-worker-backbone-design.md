# AWSops v2 — P2: 비동기 워커 백본 (Async Worker Backbone) 설계 문서

- **작성일**: 2026-06-02
- **상태**: Draft (브레인스토밍 합의 완료 — lean 백본 + Aurora worker_jobs/S3 확정; 구현 계획 착수 전)
- **관계**: v2 아키텍처 spec(`2026-05-30-awsops-v2-architecture-design.md`) §2/§3/§9의 P2를 구체화. ADR-029(변경 작업 프레임워크)·ADR-030(Fargate+Aurora) 계승.
- **선행/후속**: P1(인프라·web·Aurora·AgentCore) 완료 → **P2(이 문서)** → P3(에이전트+UI, 무거운 ops를 이 백본 위에).

---

## 1. 목표 & 범위 결정

**목표**: 무겁고 메모리가 튀거나 오래 걸리는 작업을 web 요청 경로에서 떼어 **관리형 비동기 백본**(SQS + Step Functions + Lambda/Fargate 워커)으로 격리한다. 워커가 OOM으로 죽어도 web은 무사(spec §2 OOM 안전성).

**범위 결정 (브레인스토밍 확정)**:
- **lean 백본 + 증명 워커** — 순수 인프라 계층. v2 web은 현재 thin BFF(`/api/{health,db,stream}`)라 **옮길 실제 무거운 작업이 아직 없다**(AI 합성·리포트·스캔은 v1 기능, 대부분 P3 에이전트와 함께 v2 도입). 따라서 P2는 백본 + 하이브리드(Lambda/Fargate) + OOM 격리를 **증명**하고, 실제 무거운 ops는 P3+에서 이 백본 위에 올린다.
- **잡/결과 모델 = Aurora `worker_jobs` 테이블 + S3 아티팩트** — app-facing 잡 API, SFN 보존기간 무관, 멱등 dedup 용이. 큰 결과물은 S3(ADR-029 Object Lock 감사).

**Non-goal (연기)**: 실제 무거운 ops 포팅(리포트/AI 합성/대용량 스캔 → P3+); ADR-029의 mutate 의미론(승인 워크플로·1급 롤백·mutate-action 레지스트리 → 실제 mutate op가 생기는 P3+); 멀티큐/우선순위/팬아웃 스케줄링(YAGNI).

---

## 2. 아키텍처 & 데이터 흐름

```
[web thin BFF]
  POST /api/jobs {type, payload, idempotency_key?}
    ├─ Aurora worker_jobs INSERT (status=queued, idempotency_key UNIQUE → 중복 시 기존 job 반환)
    └─ SQS(jobs) SendMessage {job_id, type}
    → 200 {job_id}

[SQS jobs 큐] ──(트리거)──> [디스패처 Lambda]   ← ADR-029 "작업별 Lambda 디스패처 + SFN" 패턴(spec §3)
                              · kill-switch(SSM /ops/awsops-v2/workers/enabled) 확인 — off면 예외→메시지 재큐
                              · SFN StartExecution(name=job_id) {job_id, type, payload}
                                — name=job_id가 멱등 보장(중복 메시지→ExecutionAlreadyExists→no-op). 디스패처 Aurora 미접근(경량).

[SFN 라우터 (Standard)]
  Choice(작업 성격: type→runtime 매핑):
    ├─ short(<15분): Invoke 워커 Lambda (.sync)
    └─ long/heavy : ECS RunTask Fargate 워커 (.sync, waitForTaskToken 불필요 — .sync가 완료까지 대기)
  Retry(워커 실패: 지수 백오프 N회) → Catch(소진) → worker_jobs status=failed, error 기록

[워커 (Lambda 또는 Fargate)]
  · 시작 시 worker_jobs status=running
  · payload 처리 (dry_run이면 부작용 없이 검증만)
  · 결과 → 작으면 worker_jobs.result_ref(inline jsonb), 크면 S3(버킷/job_id) + result_ref=s3://
  · 완료 시 status=succeeded (실패 시 status=failed + error)
  · 하드 메모리 한도(Lambda memory_size / Fargate task memory) — 초과 시 OOM kill

[web]
  GET /api/jobs/:id → worker_jobs 상태/result_ref (S3면 presigned/프록시)
  (선택) GET /api/jobs/:id/stream → SSE 진행 폴링 (worker_jobs.status 변화)
```

**런타임 라우팅 (spec §3 하이브리드)**: 짧고 가벼움(<15분) → Lambda(빠른 시작·저렴). 길거나 메모리 큼 → 단명 Fargate 태스크(시간·메모리 제한 없음, arm64). SFN의 Choice가 `type`을 런타임으로 매핑(매핑 테이블은 디스패처/SFN 입력에 포함).

---

## 3. 구성요소 (단위·인터페이스)

신규 Terraform 파일 `terraform/v2/foundation/workers.tf` (eks.tf/ai.tf처럼 자족 파일).

| 단위 | 책임 | 인터페이스/의존 |
|---|---|---|
| **SQS jobs 큐 + DLQ** | 잡 메시지 버퍼·재시도 격리 | `aws_sqs_queue` + redrive(maxReceiveCount=5)→DLQ |
| **디스패처 Lambda** | kill-switch 확인 후 SFN 시작 (경량, Aurora 미접근) | SQS 트리거(event source mapping); IAM: ssm:GetParameter, states:StartExecution. 멱등=SFN 실행명(job_id) |
| **SFN 라우터 (Standard)** | 런타임 라우팅·재시도·Catch·Fargate RunTask.sync | `aws_sfn_state_machine`; IAM: lambda:InvokeFunction(워커), ecs:RunTask+iam:PassRole, (실패 시 worker_jobs 갱신) |
| **워커 Lambda** | 짧은 작업 실행 + worker_jobs/S3 기록 | Python, VPC-attached(Aurora SG), 하드 memory_size; IAM: Aurora 접근, s3:PutObject |
| **Fargate 워커 태스크** | 길/메모리큰 작업 + OOM 시연 모드 | arm64 컨테이너(ECR), 하드 task memory; ECS task role: Aurora, s3:PutObject; cmd: `--job-id <id> [--oom]` |
| **Aurora `worker_jobs`** | 잡 상태·결과·멱등 키 | schema.sql 추가 (§4); web/워커 공용 |
| **S3 아티팩트 버킷** | 큰 결과물 + ADR-029 감사 | `aws_s3_bucket` + Object Lock(governance) + 버전관리 + SSE-KMS |
| **SSM kill-switch** | 워커 실행 전역 토글 | `aws_ssm_parameter /ops/awsops-v2/workers/enabled`(String, "true"/"false") |
| **web /api/jobs** | enqueue/status/SSE | 신규 라우트 3개; web task role +sqs:SendMessage +s3:GetObject |

**워커 Aurora 접근**: 워커는 private subnet에서 Aurora(앱 SG :5432)에 직접 접근(v1 VPC Lambda 패턴; Fargate 워커는 클러스터가 이미 VPC 내). 디스패처 Lambda는 **Aurora 미접근**(SFN 실행명=job_id로 멱등) — 경량 유지. payload는 SFN 입력으로 전달돼 **워커만 DB/S3 기록**.

---

## 4. 데이터 모델 — `worker_jobs` (schema.sql 추가)

ADR-030의 7개 app-state 테이블과 **별개의 인프라 테이블**(비동기 잡 추적; app-state 모델 위배 아님).

```sql
CREATE TABLE IF NOT EXISTS worker_jobs (
  job_id          UUID PRIMARY KEY,
  type            TEXT NOT NULL,                         -- 라우팅·핸들러 선택 키
  runtime         TEXT,                                  -- 'lambda' | 'fargate' (라우팅 결과)
  status          TEXT NOT NULL DEFAULT 'queued'         -- queued|running|succeeded|failed|canceled
                    CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_ref      TEXT,                                  -- inline JSON 또는 s3://bucket/key
  error           TEXT,
  dry_run         BOOLEAN NOT NULL DEFAULT false,
  idempotency_key TEXT UNIQUE,                           -- 중복 제출 dedup (NULL 허용)
  sfn_execution_arn TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);
-- updated_at touch 트리거는 기존 touch_updated_at() 재사용
```

---

## 5. OOM 격리 증명 (= spec §9 P2 완료기준)

- **Fargate 워커 `--oom` 시연 모드**: 태스크 memory 한도를 초과하도록 메모리 할당 → 컨테이너 OOM kill.
- 트리거 → Fargate 태스크 OOM 종료 → SFN RunTask.sync가 실패 감지 → Catch → `worker_jobs.status=failed` + error → **그 동안 web(ECS awsops-v2-web)은 healthy·서빙 유지**(무영향) 검증. ECS web의 healthCheck/ALB는 워커와 독립이므로 영향 0임을 실측.

---

## 6. ADR-029 범위 (P2 = 실행 백본 + 안전 훅)

| 통제 | P2 | 비고 |
|---|---|---|
| 멱등성 토큰 | ✅ | worker_jobs.idempotency_key UNIQUE + 디스패처 dedup |
| 킬 스위치 | ✅ | SSM 플래그, 디스패처가 확인 |
| S3 Object Lock 감사 | ✅ | 아티팩트 버킷 Object Lock(governance) |
| dry-run | ✅(통과·존중) | payload.dry_run → 워커가 부작용 없이 검증; 증명 워커는 no-op |
| 승인 워크플로·1급 롤백·mutate-action 레지스트리 | ⛔ 연기(P3+) | 아직 mutate op 없음(YAGNI). 백본은 read/compute 워커로 증명 |

---

## 7. 에러 처리 & 복원력

- SFN: 워커 단계 Retry(지수 백오프) + Catch → worker_jobs=failed. SQS: maxReceiveCount 초과 → DLQ(운영자 조사).
- 워커: 하드 메모리 한도(OOM 격리), 시작 시 running·종료 시 terminal 상태 기록(크래시 시 SFN Catch가 보정). 
- 디스패처 멱등: 동일 메시지 재전달 시 worker_jobs 상태로 중복 SFN 시작 방지.
- web: enqueue 실패(SQS/DB) → 4xx/5xx + job 행 미생성(또는 failed 마킹). 워커 장애는 web 가용성과 무관.

---

## 8. 검증 (GREEN 기준)

1. enqueue → **Lambda** 잡이 web 밖에서 실행 → 결과가 worker_jobs/S3에.
2. enqueue → **Fargate** 잡 실행 → 결과 기록.
3. **Fargate 워커 OOM 트리거 → job=failed + web 무영향**(ECS web healthy 유지) — 핵심 기준.
4. **kill-switch** off → 잡 미실행(queued 유지/재큐); on → 정상.
5. **멱등성**: 동일 idempotency_key 재제출 → 단일 job.
6. `terraform plan` clean(영드리프트), web 배포 정상(P1 healthCheck 수정 반영됨).

---

## 9. 권장 기본값 (writing-plans에서 확정/조정)

- **디스패처**: Aurora 미접근(경량) — 멱등은 SFN 실행명(job_id). [확정]
- **워커 Aurora 접근**: VPC-attached pg(v1-proven) 기본. (대안 RDS Data API는 Aurora `enable_http_endpoint` 필요 → 미채택.)
- **SFN**: Standard(Lambda·Fargate 라우팅 + Fargate RunTask.sync 완료 대기에 적합). Express 미사용.
- **워커**: Lambda=Python+boto3; Fargate=최소 arm64 컨테이너(Python). 증명 워커는 합성 작업(sleep/메모리 할당/`--oom`).
- **web `/api/jobs`**: `POST`(enqueue)+`GET /:id`(상태/결과) 필수; SSE 진행 스트림은 선택(P1d SSE 패턴 재사용).

---

## 10. 위험 & 트레이드오프

- **비용**: SQS·SFN·상시 0 + 워커 호출당 과금(낮음). S3 Object Lock 버킷 소액.
- **운영 표면 증가**: SQS·SFN·디스패처·워커 2종. 단 도메인 경계 명확.
- **Aurora 접근 경로**: 워커 VPC-attach 시 ENI 비용/콜드스타트; Data API면 단순하나 Aurora HTTP endpoint 활성 필요 — writing-plans에서 1택.
- **증명 워커가 합성**: 실제 무거운 ops는 P3+에서 검증되나, OOM 격리·하이브리드·디스패치·결과 경로는 P2에서 실증.
