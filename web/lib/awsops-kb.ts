// AWSops product knowledge base — injected as context by the in-app "AWSops Assistant" chat path
// (web/lib/assistant.ts) so the assistant can answer product/how-to questions about AWSops itself.
// Bounded single doc → injected directly as system context (no vector store). Keep it ACCURATE to
// the shipped features; edit this file when the product changes. Korean-primary (user preference).

export const AWSOPS_KB = `# AWSops 제품 가이드 (AI 어시스턴트 KB)

## AWSops란
AWSops는 **읽기 전용(read-only) AWS/Kubernetes 운영 대시보드 + AI 진단** 도구입니다.
- 실시간 AWS 리소스 조회(인벤토리/토폴로지/비용/보안/네트워크), Kubernetes(EKS) 조회, AI 채팅 진단.
- **AWS 리소스 변경·자율 실행은 동결**(SSM/IaC/콘솔은 운영자 몫). 분석은 AWSops, 행동은 사람.
- **외부 데이터 통합은 거버넌스 하 허용**: 외부 관측성 read(Prometheus/Datadog 등) + 외부 기록 write(Slack/Notion/Jira 등, flag-OFF·human-gate).

## AI 채팅 / 라우팅 모델
- 질문을 입력하면 **자동 라우팅**으로 섹션 에이전트가 선택됩니다(정규식 fast-path → Haiku 분류기).
- **섹션 에이전트**: Network, Container, Data, Security, Cost, Monitoring, IaC, Ops, Observability. 실제 도구 가용성은 배포와 연동 설정에 따릅니다.
- UI에서 만든 지침 전용 스킬에 도구 선언이나 유지된 제한이 없으면 기존 게이트웨이 읽기 도구가 기준입니다. 계정 상한은 이를 좁히며, 선언·철회된 제한의 빈 교집합은 deny-all입니다. 정책상 허용 도구가 0개이면 채팅이 안내하고 기록합니다. 정책 허용 수는 라이브 도구 검색·접속·배포 상태가 아닙니다.
- 커스텀 설정 조회가 실패하면 커스텀 선택은 중단하지만 기본 에이전트와 제품 도움말은 사용할 수 있습니다. 자동 기본 라우팅은 안내문으로 알리고, 명시적으로 선택한 커스텀 에이전트는 미가용 안내 후 재시도를 요청합니다.
- **교차 도메인 질문**은 여러 섹션을 자동 합성해 하나의 답으로 줍니다(설정에 따라). 수동 전환칩은 보조 수단입니다.
- 특정 섹션은 \`/<섹션>\`으로 선택합니다. 하이브리드 라우팅이 켜진 배포에서는 현재 계정의 활성 커스텀 에이전트도 \`/\` 목록에서 선택할 수 있습니다.

## /customization — 에이전트·스킬 관리
**연동(Integrations) → Agents & Skills → Custom Agents & Skills** 또는 **Custom Agents** 메뉴에서 관리합니다. 관리자 권한이 필요합니다.
데이터소스 등록은 **/integrations → Datasources**, Notion 자격증명과 지원하는 hosted MCP 사전 설정은 **Connectors**에서 관리합니다. 임의 MCP 등록은 지원하지 않습니다.
1. **Skills(스킬)** — 폼에 이름, 설명, Markdown 분석 지침을 작성합니다. 저장 후 스킬을 활성화하고 에이전트 행의 **Attach skill**로 연결합니다. 서버가 비활성 스킬을 포함한 기존 연결 뒤에 순서를 배정합니다.
2. **Agents(에이전트)** — kebab-case 이름, 설명, 페르소나, 기본 게이트웨이 하나와 **routingKeywords**를 지정합니다. 새로 저장한 항목은 Disabled입니다. 채팅은 서버 모델과 UI 언어를 사용합니다. 기본 명령 이름은 예약되어 있습니다.
3. **Agent Space(계정별)** — 사용할 커스텀 에이전트와 지원하는 통합의 계정 멤버십, 도구 제한을 저장합니다. 연결된 스킬은 전역 활성 상태를 따르며 별도 계정별 스킬 선택은 강제되지 않습니다. 정책 행이 없는 계정은 전역 활성 커스텀 에이전트를 사용합니다.
   - 선택한 뒤 **Save Agent Space**를 눌러 저장하세요. 빈 계정 도구 상한은 추가 제한이 없다는 뜻이며, 최종 도구 정책의 빈 목록은 모든 도구를 거부한다는 뜻입니다.
4. **Integrations (advanced)** — 지원하는 curated egress/ingress 레지스트리 등록과 활성·비활성 토글을 제공합니다. \`custom_mcp\`는 등록·활성화할 수 없습니다.
   - 새 행은 Disabled이며 자격증명 참조, 노출 도구, 소스 허용 목록, incident/write 게이트는 별도 설정입니다. 일반 데이터소스와 Notion 자격증명은 연동 허브에서 관리합니다.
   - 활성화된 curated egress-READ의 허용 도구·컨텍스트는 런타임 정책에 따라 사용됩니다. 등록만으로 연결·권한·런타임 게이트가 활성화되지는 않습니다. 기본 제공 항목은 교체·토글할 수 없습니다.

## 예시: "Prometheus 분석 에이전트" 만들기 (당신의 질문)
연동 허브와 **Custom Agents**에서:
1. **/integrations → Datasources**에서 Prometheus 연결 정보를 등록하고 연결 상태를 확인합니다. 자격증명은 서버에서 관리합니다.
2. **New Skill**에 "prometheus-rca" 등의 이름과 PromQL 작성 요령, 근거·미확인 범위를 표시할 Markdown 지침을 작성하고 활성화합니다.
3. **New Agent**: 이름 "prometheus-analyst", routingKeywords=[\`prometheus\`,\`promql\`,\`메트릭\`], 기본 게이트웨이=\`observability\`로 작성합니다. 에이전트 행에서 위 스킬을 연결하고 에이전트를 활성화합니다.
4. 계정에 **Agent Space**가 있으면 이 에이전트의 계정 멤버십도 선택하고 **Save Agent Space**를 누릅니다. 하이브리드 라우팅이 켜져 있으면 채팅의 \`/\` 목록에서 선택할 수 있습니다. 등록만으로 새 도구나 외부 관리형 에이전트가 생성되지는 않습니다.

> 참고: AWSops는 **AWS 리소스를 변경하지 않습니다**. 에이전트는 외부 데이터를 **읽어** 분석/진단하며, 외부 기록 write(티켓·메시지)는 별도 거버넌스(DLP·4-eyes·flag-OFF) 하에서만 동작합니다.

## 관리자 / 권한
- 데이터소스·지원 커넥터 등록, Agent Space 설정과 커스텀 Agent/Skill 작성·활성화는 **관리자** 권한이 필요합니다.
- 저장된 비관리자 작성 관련 메타데이터는 현재 등록 API의 관리자 확인을 해제하지 않습니다.

## 한계 / 자주 묻는 것
- 특정 도구가 없으면 AgentCore와 해당 연동 설정을 확인합니다. 연결 실패·자료 부족을 정상 상태나 0건으로 해석하지 마세요.
- AWS 리소스를 바꿔달라는 요청 → 불가(설계상 read-only). 변경은 SSM/Change Manager/IaC/콘솔에서.
`;
