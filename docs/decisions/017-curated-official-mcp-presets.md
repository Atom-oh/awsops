# ADR-017: 큐레이션 공식 MCP 프리셋 / Curated Official MCP Presets

## Status / 상태
**Accepted.**

- **Owner 지시:** 오준석(Junseok Oh), 2026-07-29 — "우리가 만든 mcp는 앞으로 유지보수가 걸림돌이 될거 같아서 외부에서 잘 관리되는 mcp가 맞는거 같아서, 다만 유명한 데이터 소스의 mcp를 우리가 먼저 정해주는게 좋긴 할거 같아". 이는 ADR-005 autonomy freeze의 예외가 아니다 — 대상은 **외부 DATA read**(ADR-007 관할, read-only 정의 밖)이며, AWS 리소스 변경도 자율 조치도 아니다.

## Context / 컨텍스트

`/integrations` 허브의 Connectors 탭은 Notion 1개만 하드코딩돼 있고(`web/app/integrations/connectors/ConnectorsTab.tsx`), `custom_mcp`라는 kind는 enum·DB CHECK·`/customization` 고급 폼에 존재하지만 그 문자열을 분기하는 런타임 코드는 하나도 없다 — 라벨만 있고 UI에 노출되지 않는 상태였다.

한편 Prometheus/ClickHouse는 이미 MCP다: `agent/lambda/{prometheus,clickhouse}_mcp.py`가 external-obs 게이트웨이의 `mcp.lambda` target으로 등록돼 있다(`scripts/v2/agentcore/catalog.py`). 이 두 관찰을 검토한 결과 실제 문제는 프로토콜이 아니라 **우리가 커넥터 코드(HTTP 클라이언트, 인증 헤더, SQL/PromQL 가드)를 직접 작성·유지보수하고 있다는 점**이었다. Datadog·ClickHouse·Tempo·Jaeger v2·Grafana·Dynatrace·Splunk 등은 이미 벤더가 공식 MCP 서버를 배포 중이고, AWS Bedrock AgentCore Gateway는 `McpServerTargetConfiguration`으로 원격 MCP 엔드포인트를 target으로 등록하는 것을 정식 지원한다(outbound auth: none/OAuth 2LO/3LO/SigV4/API key) — 지금까지 쓰던 `mcp.lambda` target 타입 외에 두 번째 target 타입이 이미 AWS 쪽에 존재한다.

Prometheus·Mimir는 조사 시점(2026-07) 공식 MCP가 없어(community만 존재) 자체 람다를 유지해야 하고, Notion의 hosted MCP는 OAuth 3LO 전용이라 헤드리스 진단 경로에 쓸 수 없어 현행 토큰 방식을 유지한다.

## Decision / 결정

**큐레이션·타입드 공식 벤더 MCP 프리셋을 external-obs 게이트웨이의 `mcpServer` target으로 등록할 수 있게 한다. 임의 사용자 지정 MCP 엔드포인트(BYO-MCP) 등록은 계속 폐기(do-not-revive) 상태로 둔다.**

- **새 substrate가 아니다** — 기존 external-obs 게이트웨이를 그대로 쓴다. `scripts/v2/agentcore/catalog.py`에 원격 MCP 프리셋 카탈로그(`MCP_SERVER_TARGETS`)를 추가하고, `provision.py`가 `targetConfiguration = {"mcp": {"mcpServer": {"endpoint": ..., "listingMode": "DEFAULT"}}}` 형태로 생성한다. 기존 `TARGETS`(`mcp.lambda`)와 병존하되, 같은 kind가 두 target 타입에 동시에 존재할 수 없다(툴 이름 중복·비결정적 dedup 방지).
- **엔드포인트는 데이터, 코드가 아니다** — `official_mcp_endpoints`(map, 기본 `{}`) + `official_mcp_enabled`(bool, 기본 **false**) terraform 변수로 배포별 실제 URL을 주입한다. 미설정 프리셋은 SKIP·exit 0(기존 flag-off 패턴과 동일).
- **큐레이션 대상만** — 공식 MCP가 존재하고 헤드리스(비-브라우저 OAuth) 인증이 가능한 kind만 프리셋화한다(Datadog·ClickHouse self-host·Tempo·Jaeger·Grafana self-host·Dynatrace·Splunk·New Relic-preview). 공식 MCP가 없거나(Prometheus·Mimir) 헤드리스 인증이 불가능한(Notion hosted) kind는 자체 람다/기존 방식을 유지한다.
- **`custom_mcp`(임의 사용자 지정 엔드포인트 등록)는 이 ADR로도 여전히 폐기 상태다** — BASELINE §2의 "폐기(do-not-revive): BYO-MCP" 조항은 변경되지 않는다. 이 ADR이 허용하는 것은 **admin이 미리 정한 벤더 프리셋**일 뿐, 사용자가 URL을 직접 입력하는 경로가 아니다.
- **자격증명**은 신규 저장소를 만들지 않는다 — 기존 `ops/${project}/integrations/credentials` Secrets Manager 시크릿과 `web/lib/integration-credentials.ts`의 advisory-lock 쓰기 경로를 재사용한다.
- **capability는 항상 `read`.** 쓰기(`integrations_write_enabled`)는 이 ADR의 범위 밖이며 변경하지 않는다.

## Consequences / 결과

### Positive / 긍정
- 커넥터별 HTTP 클라이언트/SQL 가드/인증 로직을 벤더가 유지보수 — 프로토콜 변경·버그 대응 부담이 줄어든다.
- 벤더 공식 서버는 대개 우리 손코드보다 툴 커버리지가 넓다(예: Datadog GA 서버, ClickHouse 13개 read-only 툴).
- 큐레이션이므로 ADR-007이 이미 그려둔 "admin 등록 벤더 프리셋만 허용" 라인 안에서 처리된다 — 새 거버넌스 계층이 필요 없다.

### Negative / Trade-offs
- 원격 target은 툴 스키마를 서버가 소유한다(`listingMode=DEFAULT`가 캐싱) — 우리 쪽 `toolAllowlist` 서버측 강제(ADR-004)는 여전히 유지되지만, 툴의 정확한 인풋 스키마 변경은 우리가 통제할 수 없다.
- 벤더별 인증 모양이 제각각이라(헤더 2개 요구 등) 프리셋마다 검증이 필요하고, 일부(New Relic 등)는 preview 단계라 변경 가능성이 있다.
- 전환 기간 동안 자체 람다와 원격 target이 공존할 수 있어 kind 단위 순차 전환·상호배제 검증이 필요하다.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: capability=read 고정, 서버측 `exposed_tools`/toolAllowlist 유지, 자격증명은 기존 Secrets Manager ARN-ref 경로 재사용(신규 평문 저장 없음). `custom_mcp` 폐기 유지로 임의 엔드포인트 attack surface 확장 없음.
- **Operational Excellence**: 벤더 유지보수로 우리 커넥터 코드의 장기 유지보수 부담 감소. `official_mcp_enabled` 기본 false → 게이트 규율(§1) 준수, `plan`=무변경.
- **Reliability**: 기존 SKIP-on-missing-endpoint·멱등 재실행 패턴 재사용 — 전환 실패 시 자체 람다로 즉시 되돌릴 수 있는 롤백 경로 보존(람다 소스 삭제하지 않음).
- **Cost**: default-off=$0. 켜져도 게이트웨이 target 등록 자체는 무료(Lambda 호출 비용만 제거).

---

**관련 BASELINE 갱신:** §2 게이트 register에 `official_mcp_enabled` 추가, §3 인덱스에 ADR-017 추가. 같은 PR.
