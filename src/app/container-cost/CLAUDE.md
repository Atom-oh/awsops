# Container Cost / 컨테이너 비용

## Role / 역할
ECS Task and EKS Pod cost analysis page.
ECS Task 및 EKS Pod 비용 분석 페이지.

## Files / 파일
- `page.tsx` — Container Cost dashboard (Phase 1: ECS, Phase 2: EKS/OpenCost)

## Data Sources / 데이터 소스
- Phase 1: Steampipe `aws_ecs_task` + CloudWatch Container Insights (`AWS/ECS/ContainerInsights`)
- Phase 2: OpenCost REST API (port 9003) — deferred

## Cost Calculation / 비용 계산
- Fargate: vCPU-hours x unit price + GB-hours x unit price (configurable in data/config.json)
- EC2 launch type: requires node cost allocation (not implemented in Phase 1)
