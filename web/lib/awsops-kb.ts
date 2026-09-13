// AWSops product knowledge base — injected as context by the in-app "AWSops Assistant" chat path
// (web/lib/assistant.ts) so the assistant can answer product/how-to questions about AWSops itself.
// Bounded single doc → injected directly as system context (no vector store). Keep it ACCURATE to
// the shipped features; edit this file when the product changes. Korean-primary (user preference).

export const AWSOPS_KB = `# AWSops 제품 가이드 (AI 어시스턴트 KB)

## AWSops란
AWSops는 **읽기 전용(read-only) AWS/Kubernetes 운영 대시보드 + AI 진단** 도구입니다.
- 실시간 AWS 리소스 조회(인벤토리/토폴로지/비용/보안/네트워크), Kubernetes(EKS) 조회, AI 채팅 진단.
- **AWS 리소스 변경·자율 실행은 영구 동결**(SSM/IaC/콘솔은 운영자 몫). 분석은 AWSops, 행동은 사람.
- **외부 데이터 통합은 거버넌스 하 허용**: 외부 관측성 read(Prometheus/Grafana/Datadog 등) + 외부 기록 write(Slack/Notion/Jira 등, flag-OFF·human-gate).

## AI 채팅 / 라우팅 모델
- 질문을 입력하면 **자동 라우팅**으로 섹션 에이전트가 선택됩니다(정규식 fast-path → Haiku 분류기).
- 섹션과 도구의 실제 가용성은 배포된 게이트웨이와 런타임 게이트에 따릅니다. 등록이나 정책 허용 수가 라이브 접속 성공을 뜻하지 않습니다.
- UI의 지침 전용 스킬에 선언·유지된 제한이 없으면 기존 게이트웨이 읽기 도구가 기준입니다. 계정 상한은 이를 좁히며 선언·철회된 제한의 빈 교집합은 deny-all입니다. 정책상 0개이면 채팅이 안내합니다.
- **교차 도메인 질문**은 여러 섹션을 자동 합성해 하나의 답으로 줍니다(설정에 따라). 수동 전환칩은 보조 수단입니다.
- 특정 에이전트로 고정하려면 채팅 입력에서 \`/<섹션 또는 커스텀에이전트>\`로 핀(pin)할 수 있습니다.

## /customization — 에이전트·스킬·통합 만들기
관리자는 **연동 → Agents & Skills → Custom Agents & Skills**에서 다음을 구성합니다:
1. **Integrations (advanced)** — 지원하는 curated egress/ingress 레지스트리 등록과 활성·비활성 토글. custom_mcp는 등록·활성화할 수 없습니다.
   - 일반 데이터소스와 Notion 자격증명은 **연동 허브**의 Datasources/Connectors에서 관리합니다. 고급 레지스트리는 새 행을 비활성으로 저장하며 자격증명 참조·노출 도구·소스 허용 목록·incident/write 게이트는 별도 설정입니다.
   - 활성화된 curated egress-READ의 허용 도구·컨텍스트만 런타임 정책에 따라 사용됩니다. 등록만으로 접속·권한·기능 게이트가 활성화되지는 않습니다.
2. **Skills(스킬)** — New Skill 폼에 Markdown 지침을 작성하고 활성화한 뒤 에이전트에 연결합니다. 실행 코드나 zip을 설치하는 흐름은 아닙니다.
3. **Agents(에이전트)** — kebab-case 이름, 설명, 페르소나, routingKeywords, 1차 게이트웨이를 지정합니다. 채팅은 서버 모델과 선택한 UI 언어를 사용하며 이 폼에는 모델·응답 언어 선택이 없습니다.
4. **Agent Space(계정별)** — 활성 에이전트·통합과 도구 상한을 계정별로 지정합니다. 새로 등록하거나 교체한 커스텀 항목은 비활성이며 스킬은 활성화 후 순서대로 연결합니다. 기본 제공 항목은 교체·토글할 수 없습니다.

## 예시: "Prometheus 분석 에이전트" 만들기 (당신의 질문)
**연동**에서:
1. **Datasources**에서 Prometheus 인스턴스와 인증을 등록하고 작은 읽기 쿼리로 접근을 확인합니다.
2. **Skills → New Skill**: 예) "prometheus-rca" — PromQL 작성 요령, 자주 보는 메트릭(에러율·p99·포화도), 분석 절차를 \`SKILL.md\`로 작성.
3. **New Agent**: 이름 prometheus-analyst, 관련 키워드, observability 게이트웨이를 지정하고 활성 스킬을 연결합니다.
4. 에이전트를 활성화하고 필요한 Agent Space에 포함합니다. 하이브리드 라우팅을 사용할 수 있을 때 채팅의 / 목록에서 선택한 뒤 직접 질문을 보냅니다.

> 참고: AWSops는 **AWS 리소스를 변경하지 않습니다**. 에이전트는 외부 데이터를 **읽어** 분석/진단하며, 외부 기록 write(티켓·메시지)는 별도 거버넌스(DLP·4-eyes·flag-OFF) 하에서만 동작합니다.

## 관리자 / 권한
- Integration/MCP 등록(egress·자격증명·SSRF 표면)과 Agent Space 활성화는 **관리자**(SSM admin_emails 또는 Cognito 그룹)만 가능.
- Skill·Agent 작성, 자격증명 관리, 레지스트리 등록과 활성화는 관리자 전용입니다.

## 한계 / 자주 묻는 것
- 도구가 없거나 접근할 수 없으면 근거가 수집된 것으로 해석하지 마세요. 계정 상한이 빈 것은 추가 상한이 없다는 뜻이고, 최종 도구 정책의 빈 목록은 도구를 모두 거부한다는 뜻입니다.
- AWS 리소스를 바꿔달라는 요청 → 불가(설계상 read-only). 변경은 SSM/Change Manager/IaC/콘솔에서.
`;
