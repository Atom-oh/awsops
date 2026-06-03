# ADR-002: AI 하이브리드 라우팅 / AI Hybrid Routing

## 상태: 승인됨 / Status: Accepted

## 컨텍스트 / Context
AI 어시스턴트는 코드 실행, 네트워크 문제 해결, AWS 리소스 쿼리, 일반 질문의 4가지 유형을 처리해야 합니다. 각 유형은 서로 다른 데이터 소스와 처리 방식이 필요합니다.
(AI Assistant needs to handle 4 types of questions: code execution, network troubleshooting, AWS resource queries, and general questions. Each requires different data sources and processing.)

## 결정 / Decision
키워드 감지를 기반으로 질문을 다른 백엔드로 라우팅합니다:
(Route questions to different backends based on keyword detection:)
1. 코드 실행 → Bedrock + AgentCore 코드 인터프리터
   (Code execution → Bedrock + AgentCore Code Interpreter)
2. 네트워크(ENI, 라우트, 플로우 로그) → AgentCore 런타임(Strands + Gateway MCP)
   (Network (ENI, route, flow log) → AgentCore Runtime (Strands + Gateway MCP))
3. AWS 리소스(EC2, VPC, RDS) → Steampipe 쿼리 + Bedrock Direct
   (AWS resources (EC2, VPC, RDS) → Steampipe query + Bedrock Direct)
4. 일반 → AgentCore 런타임 → Bedrock 폴백
   (General → AgentCore Runtime → Bedrock fallback)

## 이유 / Reason
- AgentCore 런타임은 격리된 microVM에서 실행 → 로컬호스트 Steampipe에 접근 불가
  (AgentCore Runtime runs in isolated microVM → cannot access localhost Steampipe)
- Steampipe는 실시간 데이터를 제공 → AWS 리소스 질문에 최적
  (Steampipe provides real-time data → best for AWS resource questions)
- Gateway MCP 도구(Lambda) → 네트워크 분석에 최적 — Reachability Analyzer, TGW 라우트, NACL
  (Gateway MCP tools (Lambda) → best for network analysis — Reachability Analyzer, TGW routes, NACLs)
- 코드 인터프리터 → 계산 및 데이터 분석에 최적
  (Code Interpreter → best for computation and data analysis)

## 결과 / Consequences
- `api/ai/route.ts`에 `needsCodeInterpreter()`, `needsAgentCore()`, `needsAWSData()` 키워드 함수 구현
  (`needsCodeInterpreter()`, `needsAgentCore()`, `needsAWSData()` keyword functions in `api/ai/route.ts`)
- AgentCore 콜드 스타트에 30-60초 소요 가능
  (AgentCore cold start can take 30-60 seconds)
- Steampipe 쿼리는 5분간 캐시됨
  (Steampipe queries cached for 5 minutes)

## 업데이트 / Update (2026-06-03, co-agent 3-AI review)
- **라우트는 현재 11개입니다 (위 본문의 4가지 유형은 채택 시점 기준).** 라우터는 v1.8.0 기준 **11개 우선순위 라우트**(code/network/container/iac/data/security/monitoring/cost/datasource/aws-data/general)로 확장되었습니다 — ADR-011·ADR-016·ADR-025 및 루트 `CLAUDE.md`의 라우팅 표 참조. 일부 ADR(특히 ADR-009)이 "17-route"로 인용한 것은 **오기이며 정답은 11**입니다.
- **The router now has 11 routes (the "4 types" above is the acceptance-time scope).** It expanded to **11 priority routes** as of v1.8.0 (code/network/container/iac/data/security/monitoring/cost/datasource/aws-data/general) — see ADR-011, ADR-016, ADR-025, and the AI Routing table in the root `CLAUDE.md`. Any "17-route" citation (notably in ADR-009) is **incorrect; the correct count is 11**.
