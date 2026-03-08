# ADR-005: VPC Lambda for Steampipe SQL Access / Steampipe SQL 접근을 위한 VPC Lambda

## Status: Accepted / 상태: 승인됨

## Context / 컨텍스트
AgentCore Runtime microVM cannot access EC2 localhost:9193 (Steampipe PostgreSQL). Initial steampipe-query Lambda used boto3 keyword fallback (4 APIs only, no real SQL).
(AgentCore Runtime microVM은 EC2 localhost:9193(Steampipe PostgreSQL)에 접근할 수 없습니다. 초기 steampipe-query Lambda는 boto3 키워드 폴백을 사용했습니다 — API 4개만 지원, 실제 SQL 미지원.)

## Decision / 결정
Deploy steampipe-query and istio-mcp Lambda in VPC with pg8000 (pure Python PostgreSQL driver). Steampipe configured with `--database-listen network`. EC2 SG allows Lambda SG inbound on port 9193.
(steampipe-query 및 istio-mcp Lambda를 VPC 내에 pg8000(순수 Python PostgreSQL 드라이버)과 함께 배포합니다. Steampipe는 `--database-listen network`으로 구성합니다. EC2 보안 그룹이 Lambda 보안 그룹의 포트 9193 인바운드를 허용합니다.)

## Consequences / 결과
- Full SQL access to 580+ Steampipe tables
  (580개 이상의 Steampipe 테이블에 대한 완전한 SQL 접근)
- pg8000 chosen over psycopg2 (native binary incompatible with Lambda)
  (psycopg2 대신 pg8000 선택 — 네이티브 바이너리가 Lambda와 호환되지 않음)
- Lambda cold start slightly longer (VPC ENI attachment)
  (Lambda 콜드 스타트가 약간 길어짐 — VPC ENI 연결)
- EC2 SG must allow Lambda SG on port 9193
  (EC2 보안 그룹이 Lambda 보안 그룹의 포트 9193을 허용해야 함)
- Steampipe must listen on network (not localhost)
  (Steampipe가 네트워크에서 수신해야 함 — localhost가 아님)
