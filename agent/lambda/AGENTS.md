<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: ad603f88978d · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# Lambda Module (AgentCore MCP tools)

## What this is
A set of Lambda functions (one per AWS service area) plus one shared module (`cross_account.py`). Each Lambda implements the MCP tools exposed by an AgentCore Gateway. Gateways are role-based: network, container, iac, data, security, monitoring, cost, ops. A `create_targets.py` script registers every Gateway Target via boto3.

## Architectural boundaries
- One Lambda ≈ one AWS service domain (VPC, EKS, IAM, CloudWatch, Cost Explorer, …). Keep service logic inside its own Lambda; do not cross-wire tools between service files.
- Cross-account access goes through `cross_account.py` only (STS AssumeRole, credential caching, ExternalId, audit logging). Do not hand-roll AssumeRole in individual tool Lambdas.
- VPC-attached Lambdas (e.g. `steampipe-query`, Istio) reach Aurora/Steampipe over the network; non-VPC Lambdas use AWS SDK calls.

## Conventions a reviewer must enforce
- **Read-only is absolute in v2 — no exceptions.** Any tool that mutates AWS state must not be reachable in v2. Mutating v1 tools are kept "dark" and replaced by describe-only equivalents:
  - `reachability.py` (creates a network-insights path = write) → use `reachability_read_mcp.py` (describe-only, computed connectivity, static SG/NACL/route).
  - `aws_core_mcp.py` `call_aws` (arbitrary CLI = mutation vector) → use `core_helpers_mcp.py` (prompt_understanding + suggest_aws_commands only; no `call_aws`).
  - `aws_istio_mcp.py` (needs live Steampipe) → use `istio_read_mcp.py` (Istio CRDs via EKS k8s API, presigned-STS token, stdlib urllib/ssl).
  - Flag any new tool that performs create/update/delete/run-arbitrary-command — it does not belong here.
- **Gateway Targets must be created via Python/boto3** — the CLI has inlinePayload problems.
- **Every target requires `credentialProviderConfigurations: GATEWAY_IAM_ROLE`.**
- **VPC Lambdas use `pg8000`, not `psycopg2`** (steampipe-query, istio).
- Tool schema shape: `inlinePayload: [{name, description, inputSchema: {type, properties, required}}]`.

## v1 vs v2 scope
This module is reused from v1 (`src/`) into v2 (`web/`, `terraform/v2/`). v2 tightens the contract: strictly read-only, the `*_read_mcp.py` / `core_helpers_mcp.py` variants are the v2 path, and the original mutating files stay dark. When reviewing v2 changes, assume single-account by default; only the explicit `cross_account.py` path may assume a different account. Do not promote a dark v1 tool into the v2 wiring.
