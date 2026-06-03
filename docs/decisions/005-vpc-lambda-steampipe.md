# ADR-005: Steampipe SQL 접근을 위한 VPC Lambda / VPC Lambda for Steampipe SQL Access

## 상태: 승인됨 / Status: Accepted

> **v2 note (2026-06-03)**: the EC2-host networking path (Lambda SG → EC2 SG on port 9193) is superseded **for v2** by **ADR-030** — Steampipe runs as the `awsops-steampipe` Fargate task, so the path becomes Lambda/task → Service Connect (`awsops-steampipe.awsops.local:9193`). Accepted as v1 history. / EC2 호스트 네트워킹 경로(Lambda SG → EC2 SG, 9193)는 **v2에 한해 ADR-030**이 승계 — Steampipe가 `awsops-steampipe` Fargate 태스크로 동작하여 경로가 Lambda/태스크 → Service Connect(`awsops-steampipe.awsops.local:9193`)로 변경. v1 이력으로 Accepted 유지.

## 컨텍스트 / Context
AgentCore Runtime microVM은 EC2 localhost:9193(Steampipe PostgreSQL)에 접근할 수 없습니다. 초기 steampipe-query Lambda는 boto3 키워드 폴백을 사용했습니다 — API 4개만 지원, 실제 SQL 미지원.
(AgentCore Runtime microVM cannot access EC2 localhost:9193 (Steampipe PostgreSQL). Initial steampipe-query Lambda used boto3 keyword fallback — 4 APIs only, no real SQL.)

## 결정 / Decision
steampipe-query 및 istio-mcp Lambda를 VPC 내에 pg8000(순수 Python PostgreSQL 드라이버)과 함께 배포합니다. Steampipe는 `--database-listen network`으로 구성합니다. EC2 보안 그룹이 Lambda 보안 그룹의 포트 9193 인바운드를 허용합니다.
(Deploy steampipe-query and istio-mcp Lambda in VPC with pg8000 (pure Python PostgreSQL driver). Steampipe configured with `--database-listen network`. EC2 SG allows Lambda SG inbound on port 9193.)

## 결과 / Consequences
- 580개 이상의 Steampipe 테이블에 대한 완전한 SQL 접근
  (Full SQL access to 580+ Steampipe tables)
- psycopg2 대신 pg8000 선택 — 네이티브 바이너리가 Lambda와 호환되지 않음
  (pg8000 chosen over psycopg2 — native binary incompatible with Lambda)
- Lambda 콜드 스타트가 약간 길어짐 — VPC ENI 연결
  (Lambda cold start slightly longer — VPC ENI attachment)
- EC2 보안 그룹이 Lambda 보안 그룹의 포트 9193을 허용해야 함
  (EC2 SG must allow Lambda SG on port 9193)
- Steampipe가 네트워크에서 수신해야 함 — localhost가 아님
  (Steampipe must listen on network — not localhost)
