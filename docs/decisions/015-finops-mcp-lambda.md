# ADR-015: FinOps MCP Lambda for Cost Gateway / Cost Gateway FinOps MCP 람다

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

Before this change, the Cost Gateway exposed 9 MCP tools backed by three APIs: Cost Explorer (spend reporting), Pricing (rate lookup), and Budgets (threshold tracking). This surface is excellent at answering "how much did we spend?" but it cannot answer "how much can we save?" because AWS's cost-optimization recommendations live on a different set of APIs with different enablement models, different refresh cadences, and different IAM permissions.

이 변경 이전에 Cost Gateway는 Cost Explorer(지출 보고), Pricing(요금 조회), Budgets(임계치 추적) 세 가지 API를 기반으로 9개의 MCP 도구를 제공했다. 이 영역은 "얼마를 썼는가?"에는 훌륭하게 답하지만 "얼마를 절약할 수 있는가?"에는 답할 수 없다. AWS의 비용 최적화 권고사항은 서로 다른 활성화 모델, 갱신 주기, IAM 권한을 가진 별도의 API 집합에 존재하기 때문이다.

Operators were asking the AgentCore Cost route for rightsizing advice, idle-resource reports, and RI/SP coverage -- all questions the existing Lambda could not answer. A parallel approach was needed for purpose-built FinOps surfaces.

운영자들은 AgentCore Cost 라우트에 rightsizing 조언, 유휴 리소스 보고, RI/SP 커버리지 등을 요구하고 있었으며 이는 기존 Lambda가 답할 수 없는 질문이었다. FinOps 전용 API 영역을 위한 병렬 접근이 필요했다.

Key constraints / 핵심 제약:

- Must not widen the existing `aws_cost_mcp.py` IAM policy with recommendation-only permissions
- Must degrade gracefully when Compute Optimizer opt-in or Business/Enterprise Support is absent
- Must remain routable via the same Cost Gateway so no new classifier route is introduced
- Must align with ADR-004's role-split principle (gateways by role, Lambdas by API family)

## Decision / 결정

Add a dedicated `aws_finops_mcp.py` Lambda to the Cost Gateway that wraps four purpose-built AWS recommendation surfaces as MCP tools. The existing `aws_cost_mcp.py` retains its spend-analysis scope; the new Lambda owns the optimization-recommendation scope.

Cost Gateway에 전용 `aws_finops_mcp.py` Lambda를 추가하여 네 가지 AWS 권고 전용 API를 MCP 도구로 래핑한다. 기존 `aws_cost_mcp.py`는 지출 분석 영역을 유지하고, 신규 Lambda는 최적화 권고 영역을 담당한다.

### Wrapped APIs and tools / 래핑한 API 및 도구

```text
aws_finops_mcp.py (5 tools)
  - get_rightsizing_recommendations          -> Compute Optimizer (EC2, RDS, ECS, Lambda)
  - get_savings_plans_recommendations        -> Cost Explorer SP APIs
  - get_reserved_instance_recommendations    -> Cost Explorer RI APIs (utilization + coverage)
  - get_cost_optimization_hub_recommendations -> Cost Optimization Hub (org-level aggregate)
  - get_trusted_advisor_cost_checks          -> Trusted Advisor (idle, unused EIP, unattached EBS)
```

Cost Gateway now routes across two Lambdas totalling 14 tools while the Gateway itself continues to expose 9 tool *categories* (counted by role, not by Lambda). Tool usage remains inferred from response keywords as with the other gateways.

Cost Gateway는 이제 두 개의 Lambda에 걸쳐 총 14개 도구를 라우팅하며, Gateway 자체는 9개의 도구 *범주*를 계속 노출한다(역할 기준, Lambda 기준 아님). 도구 사용 내역은 다른 게이트웨이와 마찬가지로 응답 키워드로 추론한다.

### IAM per Lambda / Lambda별 IAM

The FinOps Lambda requires permissions the original Cost Lambda never needed: `compute-optimizer:Get*`, `ce:GetSavingsPlansUtilization*`, `ce:GetReservedInstanceUtilization*`, `cost-optimization-hub:ListRecommendations`, and `trustedadvisor:Describe*`. Keeping a second Lambda lets each function hold a minimal, auditable policy rather than widening the existing Cost Lambda's surface.

FinOps Lambda는 기존 Cost Lambda가 필요로 하지 않았던 권한이 필요하다: `compute-optimizer:Get*`, `ce:GetSavingsPlansUtilization*`, `ce:GetReservedInstanceUtilization*`, `cost-optimization-hub:ListRecommendations`, `trustedadvisor:Describe*`. 두 번째 Lambda를 유지하면 기존 Cost Lambda의 권한을 확장하는 대신 각 함수가 최소한의 감사 가능한 정책을 유지할 수 있다.

### Graceful unavailability / 비활성 상태 우아한 처리

Compute Optimizer requires explicit opt-in per account. Trusted Advisor cost checks require Business or Enterprise Support. Cost Optimization Hub is Organization-scoped. The Lambda catches `AccessDeniedException`, `OptInRequiredException`, and `SubscriptionRequiredException` per tool and returns a structured `{ available: false, reason }` response rather than propagating a Lambda error, so the AI route can explain the gap to the user instead of failing the whole request.

Compute Optimizer는 계정별 명시적 opt-in이 필요하다. Trusted Advisor 비용 점검은 Business 또는 Enterprise Support를 요구한다. Cost Optimization Hub는 조직 범위이다. Lambda는 도구별로 `AccessDeniedException`, `OptInRequiredException`, `SubscriptionRequiredException`을 포착하여 Lambda 오류를 전파하는 대신 구조화된 `{ available: false, reason }` 응답을 반환한다. 덕분에 AI 라우트는 전체 요청을 실패시키지 않고 사용자에게 해당 상황을 설명할 수 있다.

## Rationale / 근거

- **Different API surface**: FinOps APIs return recommendations, not billing data. Response shapes differ (findings, estimated savings, migration effort). Co-locating them with Cost Explorer would blur the Lambda's single responsibility.
  (**다른 API 영역**: FinOps API는 청구 데이터가 아닌 권고사항을 반환한다. 응답 구조가 다르다(finding, 예상 절감액, 마이그레이션 노력). Cost Explorer와 같은 곳에 두면 Lambda의 단일 책임이 흐려진다.)
- **Different enablement model**: Opt-in and Support-plan gates affect only the FinOps surfaces. Isolating them keeps the spend-reporting Lambda always-on and deterministic.
  (**다른 활성화 모델**: Opt-in 및 Support 플랜 게이팅은 FinOps 영역에만 영향을 준다. 이를 분리하면 지출 보고 Lambda는 항상 작동하고 결정론적으로 유지된다.)
- **Different refresh cadence**: Recommendations refresh daily or weekly; spend data refreshes hourly. Mixing them in one Lambda would mislead users about freshness. Keeping them separate makes the cadence observable per tool category.
  (**다른 갱신 주기**: 권고사항은 일별/주별로 갱신되고 지출 데이터는 시간별로 갱신된다. 하나의 Lambda에 섞으면 사용자에게 데이터 신선도에 대한 오해를 준다. 분리하면 도구 범주별로 갱신 주기를 관찰할 수 있다.)
- **IAM least privilege**: Splitting Lambdas means `compute-optimizer:*` and `trustedadvisor:Describe*` never leak into the spend-analysis Lambda's policy.
  (**IAM 최소 권한**: Lambda 분리는 `compute-optimizer:*` 및 `trustedadvisor:Describe*`가 지출 분석 Lambda 정책으로 유출되지 않도록 한다.)
- **Extends ADR-004 cleanly**: ADR-004 split gateways by role; this decision splits one gateway's Lambdas by AWS API family -- the same principle applied one level deeper.
  (**ADR-004의 자연스러운 확장**: ADR-004는 역할별로 게이트웨이를 분리했다. 이번 결정은 한 게이트웨이의 Lambda를 AWS API 계열별로 분리하는 것이며, 같은 원칙을 한 단계 더 깊이 적용한 것이다.)

## Consequences / 결과

### Positive / 긍정적

- AgentCore Cost route can now answer "how much can we save?", not just "how much did we spend?"
  (AgentCore Cost 라우트가 "얼마를 썼는가?"뿐 아니라 "얼마를 절약할 수 있는가?"에도 답할 수 있다.)
- Graceful fallback when Compute Optimizer, Trusted Advisor, or Cost Optimization Hub are not enabled -- the tool returns an explanatory payload rather than failing the request.
  (Compute Optimizer, Trusted Advisor, Cost Optimization Hub가 활성화되지 않았을 때 요청을 실패시키지 않고 설명 페이로드를 반환하여 우아하게 대체한다.)
- Per-Lambda IAM keeps least privilege intact; adding a new recommendation source (for example Savings Plans purchase recommendations or EC2 Spot advice) drops into the same Lambda without touching Cost Explorer permissions.
  (Lambda별 IAM으로 최소 권한을 유지하며, 새로운 권고 소스(예: Savings Plans 구매 추천, EC2 Spot 조언)는 Cost Explorer 권한을 건드리지 않고 같은 Lambda에 추가할 수 있다.)
- Cost Gateway system prompt can now confidently reference rightsizing and RI/SP terminology because the tools actually exist.
  (Cost Gateway 시스템 프롬프트는 실제 도구가 존재하므로 rightsizing 및 RI/SP 용어를 자신 있게 참조할 수 있다.)

### Negative / 부정적

- Operational surface grows from 19 to 20 Lambdas; each new Lambda adds deployment, logging, and monitoring overhead.
  (운영 대상이 19개에서 20개 Lambda로 늘어나며, 각 신규 Lambda는 배포/로깅/모니터링 오버헤드를 추가한다.)
- Compute Optimizer opt-in and Support-plan-gated APIs can confuse users who expect uniform always-on behavior across the Cost route.
  (Compute Optimizer opt-in 및 Support 플랜 게이팅 API는 Cost 라우트에서 일관된 상시 동작을 기대하는 사용자에게 혼란을 줄 수 있다.)
- Recommendation latency is days, not seconds. UI and prompt messaging must explain that "no new recommendations today" is normal; otherwise users perceive stale output as broken tooling.
  (권고사항 지연은 초가 아닌 일 단위이다. UI 및 프롬프트 메시지는 "오늘 신규 권고사항 없음"이 정상임을 설명해야 하며, 그렇지 않으면 사용자가 최신 결과가 아닌 출력을 도구 고장으로 인식한다.)
- Four additional API surfaces (Compute Optimizer, Cost Explorer SP/RI, Cost Optimization Hub, Trusted Advisor) must be versioned and regression-tested against boto3 updates.
  (네 개의 추가 API 영역(Compute Optimizer, Cost Explorer SP/RI, Cost Optimization Hub, Trusted Advisor)은 boto3 업데이트에 맞춰 버전 관리 및 회귀 테스트가 필요하다.)

## References / 참고 자료

- [ADR-004: Split AgentCore Gateway by Role](./004-gateway-role-split.md) -- the role-split decision this ADR extends at the Lambda level
- [agent/lambda/aws_finops_mcp.py](../../agent/lambda/aws_finops_mcp.py) -- FinOps MCP Lambda source (5 tools)
- [agent/lambda/CLAUDE.md](../../agent/lambda/CLAUDE.md) -- Cost Gateway Lambda composition (aws_cost_mcp + aws_finops_mcp)
- [agent/CLAUDE.md](../../agent/CLAUDE.md) -- AgentCore Gateway composition and tool counts
- [docs/architecture.md](../architecture.md) -- AgentCore Gateway table
- Commit `b23be07` -- feat: FinOps MCP Lambda, deployment scripts, CDK updates, docs
