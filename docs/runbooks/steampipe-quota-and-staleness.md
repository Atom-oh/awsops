# Runbook — Steampipe 쿼터 및 인벤토리 신선도 / Steampipe Quota and Inventory Staleness

Phase 1의 Steampipe 인벤토리 sync를 운영하는 절차다. **Phase 1은 코드 구현만 되었고 이 runbook은 프로덕션 apply를 수행하지 않는다.** AgentCore의 직접 inventory/configuration API 호출은 Phase 2 catalog retirement가 배포될 때까지 현재 동작으로 유지된다.

This runbook operates the Phase 1 Steampipe inventory sync. **Phase 1 is implemented in code only; this runbook does not perform a production apply.** Direct AgentCore inventory/configuration API calls remain current behavior until Phase 2 catalog retirement is deployed.

## 1. 변수와 기본값 / Variables and defaults

| Terraform variable | Default | Allowed | Purpose |
|---|---:|---:|---|
| `steampipe_enabled` | `false` | boolean | false이면 Steampipe/sync 인프라와 비용이 0 / false creates no Steampipe/sync resources or cost |
| `steampipe_aws_max_concurrency` | 4 | integer 1–20 | global upstream concurrent-call limit |
| `steampipe_aws_bucket_size` | 4 | integer 1–40 | global burst capacity |
| `steampipe_aws_fill_rate` | 2 | 0.1–20 req/s | token-bucket refill rate |
| `steampipe_sync_reserved_concurrency` | 4 | integer 1–20 | inventory sync Lambda fan-out backpressure |

관련 고정 동작 / Related fixed behavior:

- EventBridge scheduled sync: `rate(15 minutes)`.
- Asynchronous invocation: maximum event age 900 seconds, zero retries.
- Generated config: exactly one unscoped `limiter "awsops_global"` shared across all rendered AWS connections.
- Manual inventory and security refreshes enqueue the same async Lambda path; they do not bypass its reserved concurrency.

## 2. 적용 전 검토 / Review before deployment

공유 인프라는 saved plan으로만 적용한다. `-auto-approve`를 사용하지 않는다.
Apply shared infrastructure only from a saved plan. Do not use `-auto-approve`.

```bash
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation plan -out tfplan
# Controller-approved operation only:
terraform -chdir=terraform/v2/foundation apply tfplan
```

## 3. 생성된 `aws.spc` 검사 / Inspect generated `aws.spc`

정적 기본 파일은 `scripts/v2/steampipe/aws.spc`다. 실행 중 컨테이너는 Aurora account/Region scope를 읽어 기본 경로 `/home/steampipe/.steampipe/config/aws.spc`에 실제 구성을 생성한다.
The checked-in default is `scripts/v2/steampipe/aws.spc`. The running container reads Aurora account/Region scope and renders the actual configuration at `/home/steampipe/.steampipe/config/aws.spc`.

배포 전 렌더러 검증 / Validate the renderer before deployment:

```bash
python3 -m pytest scripts/v2/steampipe/test_spc_render.py -q
```

배포 후 ECS Exec 권한이 있는 운영자는 실제 task를 읽기 전용으로 확인할 수 있다. `<cluster>`와 `<task-arn>`은 해당 환경의 값으로 바꾼다.
After deployment, an operator with ECS Exec permission may inspect the live task read-only. Replace `<cluster>` and `<task-arn>` with environment values.

```bash
aws ecs execute-command \
  --cluster <cluster> \
  --task <task-arn> \
  --container steampipe \
  --interactive \
  --command 'sed -n "1,120p" /home/steampipe/.steampipe/config/aws.spc'
```

다음을 확인한다 / Confirm:

- `plugin "aws"` block가 정확히 하나이다 / exactly one `plugin "aws"` block.
- `limiter "awsops_global"`가 정확히 하나이다 / exactly one `limiter "awsops_global"`.
- `max_concurrency`, `bucket_size`, `fill_rate`가 approved Terraform values와 일치한다.
- `scope =`가 없다. 계정·리전별 budget 증식이 아니라 하나의 global budget이어야 한다.

## 4. 배포 순서 / Deployment order

1. Terraform saved plan을 검토하고 controller-approved `apply tfplan`을 수행한다.
2. Steampipe ARM64 이미지를 build/push한다.
3. ECS Steampipe service가 stable이 될 때까지 기다린다.
4. sync 하나를 trigger한다.
5. freshness와 lifecycle log를 확인한다.

```bash
# Step 2 is the repository image workflow; preserve linux/arm64.
docker buildx build --platform linux/arm64 -f scripts/v2/steampipe/Dockerfile \
  -t <steampipe-ecr-uri>:<tag> --push scripts/v2/steampipe

# Step 4: invoke one type through the existing bounded asynchronous path.
# Use the deployed inv-sync function name from Terraform output.
aws lambda invoke \
  --cli-binary-format raw-in-base64-out \
  --function-name <inv-sync-function> \
  --invocation-type Event \
  --payload '{"type":"ec2"}' \
  /tmp/awsops-inv-sync-response.json
```

수동 UI refresh도 동일한 `InvocationType=Event` 경로와 Lambda reserved concurrency를 사용한다. 대량 refresh를 별도 병렬 호출로 우회하지 않는다.
Manual UI refresh uses the same `InvocationType=Event` path and Lambda reserved concurrency. Do not bypass it with a separate bulk parallel invocation.

## 5. 로그와 신선도 확인 / Check logs and freshness

CloudWatch Logs에서 다음 JSON event 이름을 조회한다:

- `inventory_sync_dispatch` — `type=all` fan-out이 시작됨.
- `inventory_sync_complete` — `resource_type`, `row_count`, `elapsed_ms`.
- `inventory_sync_busy` — 해당 type의 advisory lock이 이미 사용 중; retry storm을 만들지 않는다.
- `inventory_sync_failed` — `resource_type`, `elapsed_ms`, `error_category`, `error_type`.

예시 Logs Insights query / Example Logs Insights query:

```text
fields @timestamp, event, resource_type, row_count, elapsed_ms, error_category, error_type
| filter event like /^inventory_sync_/
| sort @timestamp desc
| limit 100
```

Aurora에서 `inventory_sync_runs`는 resource type별 마지막 실행 ledger이고, `inventory_resources.captured_at`은 account/region/resource row의 실제 수집 시각이다. stale 여부는 둘 다 보며, **30분을 초과한 마지막 성공 sync는 stale로 취급**한다. 성공 기록이 없으면 해당 type은 unavailable로 취급한다.

In Aurora, `inventory_sync_runs` is the per-resource-type run ledger and `inventory_resources.captured_at` is the actual collection time for an account/Region/resource row. Check both; a latest successful sync older than **30 minutes** is stale. No successful record means that type is unavailable.

```sql
SELECT resource_type, status, finished_at, row_count, error
FROM inventory_sync_runs
WHERE account_id = 'self'
ORDER BY resource_type;

SELECT resource_type, account_id, region, max(captured_at) AS latest_captured_at
FROM inventory_resources
GROUP BY resource_type, account_id, region
ORDER BY latest_captured_at ASC;
```

Phase 1 does not reroute AgentCore inventory/configuration reads. Therefore stale Aurora inventory is an operational signal for the sync and web inventory surfaces, not permission to add a silent direct-API fallback. Phase 2 must return an explicit stale/unavailable response instead.

## 6. 안전한 튜닝 / Safe tuning

**한도를 낮추는 것은 즉시 가능하다.** throttling, sync latency 증가, 또는 service instability가 보이면 `max_concurrency`, bucket size, fill rate, 또는 reserved concurrency를 낮추고 saved plan으로 반영한다.

**Raising a limit requires observed production headroom.** Increase only after evidence shows the current setting has sustained headroom without AWS throttling, increased sync age, Lambda throttles, or impact to production deployment/scaling operations. Change one control at a time, observe at least a full 15-minute cycle, and retain the prior values for rollback.

The values are safeguards, not assertions of universal AWS quotas; service, operation, account, and Region quotas differ.

## 7. 롤백 / Rollback

롤백은 파괴적 데이터베이스 변경 없이 이전 limiter defaults 또는 AgentCore catalog를 복원하는 방식이다.
Rollback restores prior limiter defaults or catalog state without destructive database changes.

1. limiter/concurrency 값을 이전 보수적 값으로 되돌리거나 `steampipe_enabled=false`로 되돌린 saved plan을 만든다.
2. controller-approved `apply tfplan`으로 적용한다.
3. 필요한 경우 현재 catalog를 유지한다. Phase 2 이후의 별도 catalog cutover가 있다면 이전 target set을 복원한다.
4. Aurora `inventory_resources`, `inventory_sync_runs`, 또는 migration을 삭제·truncate하지 않는다.
5. rollback 뒤 last successful sync와 로그를 확인하고 stale 상태를 사용자에게 명시한다.

Phase 1 alone does not retire any direct AgentCore target, so it has no AgentCore catalog rollback of its own.

## Related

- ADR-021: `docs/decisions/021-quota-isolated-inventory-reads.md`
- Approved design: `docs/superpowers/specs/2026-08-31-steampipe-quota-safe-aurora-mcp-design.md`
- Renderer: `scripts/v2/steampipe/spc_render.py`
- Sync Lambda: `scripts/v2/steampipe/sync_lambda.py`
