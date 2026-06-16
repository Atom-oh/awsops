# Plan: OpenSearch log query connector (AWS-native sigv4)

> Spec: `docs/superpowers/specs/2026-06-16-opensearch-log-connector-design.md`. Read-only OpenSearch
> MCP Lambda (sigv4 `es`, NO token → no credential UX), on the **monitoring** gateway. Public+IAM
> path by default (non-VPC Lambda); VPC-only domains behind `opensearch_vpc_enabled` (default false).
> Mirrors `aws_cloudwatch_mcp.py` (AWS-native log tools). Branch `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- Agent MCP Lambdas: `local.agent_lambdas` (for_each, py3.11, arm64, archive_file zip + cross_account.py),
  shared exec role `aws_iam_role.agent_lambda[0]`, non-VPC, env `AWSOPS_HOST_ACCOUNT_ID`. Handler
  contract: `tool_name`+`arguments`, `args.pop('target_account_id')`, `ok()`/`err()` (see network_mcp.py).
- `aws_cloudwatch_mcp.py` already does CloudWatch Logs/Insights (boto3) — OpenSearch needs sigv4 HTTP
  (`_search`), signed with `botocore.auth.SigV4Auth` (botocore ships with boto3 — no extra dep).
- `aws_iam_role_policy.agent_lambda_read` holds the read grants (ends with CrossAccountAssumeReadOnly).
- VPC networking available: `local.private_subnet_ids` + `aws_security_group.service` (agentcore output).

## Non-goals
- Cross-source triage orchestration; S3/Datadog/Dynatrace; any write/ingest. Read-only only.

## Tasks (TDD; per-task commit; `python3 -m unittest` + catalog_check + `terraform validate` green)

### Task 1: OpenSearch read MCP Lambda (TDD)
**Files:**
- Create: `agent/lambda/opensearch_mcp.py`
- Test: `agent/lambda/test_opensearch_mcp.py`
- [ ] Failing tests (unittest; mock the HTTP seam `_signed_request` and boto3 `opensearch`/session —
  no network, stdlib only):
  - `list_opensearch_domains`: boto3 `list_domain_names` + `describe_domain`; returns name+endpoint+engine.
  - `search_opensearch_logs(domain, query='ERROR', start='1h')`: resolves the domain endpoint, issues a
    POST to `https://<endpoint>/<index|_all>/_search`; body has a `bool` with `range` on `@timestamp`
    (gte=start) + `query_string`=query; `size` clamped (>50 → 50; default e.g. 20); returns hits.
  - default window: no start → last 1h (assert a `range.@timestamp.gte` is present).
  - `opensearch_indices(domain)`: GET `/_cat/indices?format=json`.
  - missing domain (list empty / not found) → structured "no OpenSearch domain" error (no crash).
  - HTTP non-2xx (e.g. 403) → structured error carrying the status.
  - `target_account_id` in arguments is popped (cross-account path uses the assumed role; host short-circuit).
  - sigv4: assert the signer (botocore SigV4Auth, service `es`) is applied before the request is sent.
- [ ] Implement `agent/lambda/opensearch_mcp.py`: `lambda_handler` (mirror network_mcp dispatch);
  `_client('opensearch'|'es', region, role_arn)` via `cross_account.get_client`; `_signed_request(method,
  url, body, region, role_arn)` — build `AWSRequest`, sign with `SigV4Auth(creds, 'es', region)`, send
  via stdlib `urllib` (timeout); `_search_body(query, start, end, size)`; the 3 tools; `ok()`/`err()`.
  Bounds: `size` cap + truncate hits. Stdlib + boto3/botocore only.
- [ ] `cd agent/lambda && python3 -m unittest test_opensearch_mcp` → green.
- [ ] Commit: `feat(agent-platform): OpenSearch read MCP Lambda — list/search-logs/indices (sigv4, read-only)`.

### Task 2: register the OpenSearch target on the monitoring gateway
**Files:**
- Modify: `scripts/v2/agentcore/catalog.py`
- [ ] Add `TARGETS["opensearch-mcp-target"]` = `{gateway:"monitoring", lambda_key:"opensearch-mcp",
  description, tools:[3 specs]}` (`_p` helper; no `target_account_id` prop). Tools:
  `list_opensearch_domains` (no req), `search_opensearch_logs` (req `domain`; opt `query`/`start`/`end`/`index`/`size`),
  `opensearch_indices` (req `domain`).
- [ ] `cd scripts/v2/agentcore && python3 catalog_check.py` → `OK` + `opensearch-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register opensearch-mcp-target on monitoring gateway`.

### Task 3: provision the OpenSearch Lambda + scoped IAM (TF)
**Files:**
- Modify: `terraform/v2/foundation/ai.tf`
- [ ] Add `"opensearch-mcp" = { file = "opensearch_mcp.py", handler = "opensearch_mcp.lambda_handler" }`
  to the `local.agent_lambdas` **base map** (the `var.agentcore_enabled ? {...}` branch — AWS-native,
  NOT integ-gated). `lambda_arns` output auto-includes it.
- [ ] Grant least-privilege on the agent_lambda role (new `aws_iam_role_policy.agent_lambda_opensearch`,
  `count = local.ac_count`, OR a statement in `agent_lambda_read`): `es:ESHttpGet` + `es:ESHttpPost` on
  `arn:aws:es:${var.region}:${acct}:domain/*/*`; `opensearch:ListDomainNames` + `opensearch:DescribeDomain`
  + `opensearch:DescribeDomains` on `*`. No `Principal:"*"`, no `0.0.0.0/0`.
- [ ] `terraform -chdir=terraform/v2/foundation fmt` (revert out-of-scope fmt drift) + `validate` → green.
- [ ] Commit: `feat(agent-platform): provision opensearch-mcp Lambda + scoped es/opensearch IAM (read-only)`.

### Task 4: optional VPC attachment for VPC-only domains (flag, default off)
**Files:**
- Modify: `terraform/v2/foundation/ai.tf`
- Modify: `terraform/v2/foundation/variables.tf`
- [ ] Add variable `opensearch_vpc_enabled` (bool, default false) with a clear description (off → no-op,
  $0; on → attach the opensearch Lambda to private subnets so it reaches a VPC-only domain).
- [ ] Add a `dynamic "vpc_config"` block on `aws_lambda_function.agent` that yields a config ONLY when
  `each.key == "opensearch-mcp" && var.opensearch_vpc_enabled` — `subnet_ids = local.private_subnet_ids`,
  `security_group_ids = [aws_security_group.service.id]`. Other Lambdas: no vpc_config (unchanged).
- [ ] When VPC is on, the lambda role needs ENI perms: add `ec2:CreateNetworkInterface`,
  `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface` (Resource `*`, the AWS-required shape)
  gated `count = var.opensearch_vpc_enabled ? 1 : 0` (separate policy → off = not present).
- [ ] `terraform -chdir=terraform/v2/foundation fmt` + `validate` → green (validate with the flag both
  default-off and, if feasible, a `-var opensearch_vpc_enabled=true` validate to catch the dynamic block).
- [ ] Commit: `feat(agent-platform): opensearch_vpc_enabled flag — optional VPC attach for VPC-only domains (off)`.

## Manual / live steps (NOT autonomous)
1. `terraform -target` apply: the opensearch Lambda + IAM (+ VPC if `opensearch_vpc_enabled=true`).
2. `make agentcore` — provision the monitoring `opensearch-mcp-target`.
3. Live: chat (monitoring) "search OpenSearch logs around <time> for errors" → CloudWatch logs confirm
   a real `_search` (unique runtimeSessionId). For a VPC-only domain, set `opensearch_vpc_enabled=true`
   first (+ persist in the live tfvars / configure.mjs).
