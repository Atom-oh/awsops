# Agent Module / 에이전트 모듈

## Role / 역할
Strands Agent for AgentCore Runtime. Connects to 7 role-based Gateways via MCP protocol.
(AgentCore 런타임용 Strands 에이전트. MCP 프로토콜을 통해 7개 역할 기반 게이트웨이에 연결.)

## Key Files / 주요 파일
- `agent.py` — Main entrypoint: dynamic Gateway selection via `payload.gateway` parameter (메인 진입점: `payload.gateway` 파라미터를 통한 동적 게이트웨이 선택)
- `streamable_http_sigv4.py` — MCP StreamableHTTP with AWS SigV4 signing (AWS SigV4 서명을 사용한 MCP StreamableHTTP)
- `Dockerfile` — Python 3.11-slim, arm64, port 8080
- `requirements.txt` — strands-agents, boto3, bedrock-agentcore, psycopg2-binary
- `lambda/` — 19 Lambda source files + `create_targets.py` (19개 Lambda 소스 파일 + 타겟 생성 스크립트)

## Rules / 규칙
- Docker image must be arm64 (`docker buildx --platform linux/arm64`)
  (Docker 이미지는 arm64 필수)
- Gateway URL selected dynamically from `GATEWAYS` dict based on payload
  (게이트웨이 URL은 payload 기반으로 `GATEWAYS` 딕셔너리에서 동적 선택)
- System prompt is role-specific (infra/iac/data/security/monitoring/cost/ops)
  (시스템 프롬프트는 역할별로 다름: infra/iac/data/security/monitoring/cost/ops)
- Fallback: if MCP connection fails, run without tools (Bedrock direct)
  (폴백: MCP 연결 실패 시 도구 없이 실행 — Bedrock 직접 호출)
