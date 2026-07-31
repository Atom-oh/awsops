# ADR-017: 큐레이션 공식 MCP 프리셋 / Curated Official MCP Presets

## Status / 상태
**Accepted.**

- **Owner 지시:** 오준석(Junseok Oh), 2026-07-29 — "우리가 만든 mcp는 앞으로 유지보수가 걸림돌이 될거 같아서 외부에서 잘 관리되는 mcp가 맞는거 같아서, 다만 유명한 데이터 소스의 mcp를 우리가 먼저 정해주는게 좋긴 할거 같아". 이는 ADR-005 autonomy freeze의 예외가 아니다 — 대상은 **외부 DATA read**(ADR-007 관할, read-only 정의 밖)이며, AWS 리소스 변경도 자율 조치도 아니다.

## Context / 컨텍스트

`/integrations` 허브의 Connectors 탭은 Notion 1개만 하드코딩돼 있고(`web/app/integrations/connectors/ConnectorsTab.tsx`), `custom_mcp`라는 kind는 enum·DB CHECK에 존재하고 `/customization` 고급 폼의 kind 드롭다운에도 선택 가능한 옵션으로 이미 노출돼 있었다(`INTEGRATION_KINDS_EGRESS`를 그대로 렌더링하므로) — 다만 그 문자열을 분기해 실제로 무언가를 하는 런타임 코드는 하나도 없었다(round-2 review 정정, 2026-07-31: 선택은 가능했지만 기능은 없는 상태였다는 것이 정확한 표현이며, "UI에 노출되지 않았다"는 이전 표현은 부정확했다).

한편 Prometheus/ClickHouse는 이미 MCP다: `agent/lambda/{prometheus,clickhouse}_mcp.py`가 external-obs 게이트웨이의 `mcp.lambda` target으로 등록돼 있다(`scripts/v2/agentcore/catalog.py`). 이 두 관찰을 검토한 결과 실제 문제는 프로토콜이 아니라 **우리가 커넥터 코드(HTTP 클라이언트, 인증 헤더, SQL/PromQL 가드)를 직접 작성·유지보수하고 있다는 점**이었다. Datadog·ClickHouse·Tempo·Jaeger v2·Grafana·Dynatrace·Splunk 등은 이미 벤더가 공식 MCP 서버를 배포 중이고, AWS Bedrock AgentCore Gateway는 `McpServerTargetConfiguration`으로 원격 MCP 엔드포인트를 target으로 등록하는 것을 정식 지원한다(outbound auth: none/OAuth 2LO/3LO/SigV4/API key) — 지금까지 쓰던 `mcp.lambda` target 타입 외에 두 번째 target 타입이 이미 AWS 쪽에 존재한다.

Prometheus·Mimir는 조사 시점(2026-07) 공식 MCP가 없어(community만 존재) 자체 람다를 유지해야 하고, Notion의 hosted MCP는 OAuth 3LO 전용이라 헤드리스 진단 경로에 쓸 수 없어 현행 토큰 방식을 유지한다.

## Decision / 결정

**큐레이션·타입드 공식 벤더 MCP 프리셋을 external-obs 게이트웨이의 `mcpServer` target으로 등록할 수 있게 한다. 임의 사용자 지정 MCP 엔드포인트(BYO-MCP) 등록은 계속 폐기(do-not-revive) 상태로 둔다.**

- **새 substrate가 아니다** — 기존 external-obs 게이트웨이를 그대로 쓴다. `scripts/v2/agentcore/catalog.py`에 원격 MCP 프리셋 카탈로그(`MCP_SERVER_TARGETS`)를 추가하고, `provision.py`가 `targetConfiguration = {"mcp": {"mcpServer": {"endpoint": ..., "listingMode": "DEFAULT"}}}` 형태로 생성한다. 기존 `TARGETS`(`mcp.lambda`)와 병존하되, 같은 kind가 두 target 타입에 동시에 존재할 수 없다(툴 이름 중복·비결정적 dedup 방지).
- **엔드포인트는 데이터, 코드가 아니다** — `official_mcp_endpoints`(map, 기본 `{}`) + `official_mcp_enabled`(bool, 기본 **false**) terraform 변수로 배포별 실제 URL을 주입한다. 미설정 프리셋은 SKIP·exit 0(기존 flag-off 패턴과 동일). **`preset_key` ↔ 호스트 바인딩은 코드로 고정되지 않고 운영자가 주장하는 값이다 — 아래 §Trade-offs의 수용된 잔여 리스크 참조.**
- **큐레이션 대상만** — 공식 MCP가 존재하고 헤드리스(비-브라우저 OAuth) 인증이 가능한 kind만 프리셋화한다(Datadog·ClickHouse self-host·Tempo·Jaeger·Grafana self-host·Dynatrace·Splunk·New Relic-preview). 공식 MCP가 없거나(Prometheus·Mimir) 헤드리스 인증이 불가능한(Notion hosted) kind는 자체 람다/기존 방식을 유지한다.
- **`custom_mcp`(임의 사용자 지정 엔드포인트 등록)는 이 ADR로도 여전히 폐기 상태다** — BASELINE §2의 "폐기(do-not-revive): BYO-MCP" 조항은 변경되지 않는다. 이 ADR이 허용하는 것은 **admin이 미리 정한 벤더 프리셋**일 뿐, 사용자가 URL을 직접 입력하는 경로가 아니다.
- **자격증명**은 신규 저장소를 만들지 않는다 — 기존 `ops/${project}/integrations/credentials` Secrets Manager 시크릿과 `web/lib/integration-credentials.ts`의 advisory-lock 쓰기 경로를 재사용한다.
- **capability는 항상 `read`이지만, 이는 선언적 라벨이며 서버측에서 강제되지 않는다(declarative label, NOT server-side enforcement).** `mcp.lambda` target은 `toolSchema.inlinePayload`로 노출 툴 집합을 하드 리밋하지만, API key 자격증명을 쓰는 `mcpServer` target에는 동등한 상한이 **AWS 쪽에 존재하지 않는다** — 툴 집합을 고정할 수 있는 유일한 필드 `McpServerTargetConfiguration.mcpToolSchema`는 authorization code grant 자격증명에서만 지원된다. 따라서 **이미 ack된 프리셋에 벤더가 write 툴을 추가하면 다음 `make agentcore`에서 재-ack 없이 흡수된다.** 이는 AgentCore가 API_KEY 경로에 툴 스키마 상한을 제공하지 않기 때문에 **알고서 수용한 잔여 리스크**다(상세·보상 컨트롤은 §Trade-offs). 쓰기 티어(`integrations_write_enabled`)는 이 ADR의 범위 밖이며 변경하지 않는다(계속 기본 false).

## Consequences / 결과

### Positive / 긍정
- 커넥터별 HTTP 클라이언트/SQL 가드/인증 로직을 벤더가 유지보수 — 프로토콜 변경·버그 대응 부담이 줄어든다.
- 벤더 공식 서버는 대개 우리 손코드보다 툴 커버리지가 넓다(예: Datadog GA 서버, ClickHouse 13개 read-only 툴).
- 큐레이션이므로 ADR-007이 이미 그려둔 "admin 등록 벤더 프리셋만 허용" 라인 안에서 처리된다 — 새 거버넌스 계층이 필요 없다.

### Negative / Trade-offs
- **[수용된 잔여 리스크 ①] 노출 툴 집합의 결정권은 벤더에게 있고, 벤더가 추가한 write 툴은 재-ack 없이 흡수된다.** Lambda target(`mcp.lambda`)은 `toolSchema.inlinePayload`가 노출 툴 집합을 하드 리밋하지만, `mcpServer` target은 `listingMode=DEFAULT`로 벤더 서버가 광고하는 툴 전부(쓰기 툴 포함)를 그대로 노출하며, provision.py는 매 실행 `synchronize_gateway_targets`를 호출해 현재 상태를 그대로 수용한다. 즉 벤더가 다음 릴리스에 mutating 툴(mute monitor / create incident / delete dashboard 등)을 추가하면 **다음 `make agentcore`에서 재-ack·PR·리뷰 없이 에이전트 툴 surface에 편입된다.** `capability=read`는 이 경로에서 **선언적 라벨이며 서버측 강제가 아니다.**
  - **왜 코드로 막을 수 없는가(외부 제약):** `bedrock-agentcore-control`에는 툴 목록을 읽는 오퍼레이션이 아예 없고(target 관련 오퍼레이션은 `Create/Get/List/Update/DeleteGatewayTarget` + `SynchronizeGatewayTargets`뿐이며 응답에 툴 이름이 없음 — botocore `2023-06-05` 모델 확인) → 스냅샷 비교조차 불가능하다. 툴 집합을 고정할 수 있는 유일한 필드 `McpServerTargetConfiguration.mcpToolSchema`는 AWS 문서상 **authorization code grant 자격증명에서만 지원**되고(이 프리셋들은 API key) 설정 시 툴 동기화 자체가 비활성화된다.
  - **알고서 수용한다(외부 제약).** 단 이것이 ADR-007 §5 의 "curation = 기술적으로 강제되는 provenance" 요건을 충족한다는 뜻은 아니다 — 충족하지 못하며, AWS 가 API_KEY 경로에 상한을 제공하지 않는 한 우리 코드로 충족시킬 방법이 없다. `read_only_note`(catalog.py)와 ack는 **툴 목록이 아니라 벤더측 컨트롤**(RBAC 스코프 / `--disable-write` / read-scoped 토큰)에 대한 attestation이며, 그 컨트롤은 나중에 추가되는 툴에도 계속 적용된다 — 그러나 그 이상은 보장하지 않는다.
  - **보상 컨트롤(존재하는 것만 적는다):** ① `official_mcp_enabled` + `integrations_enabled` 기본 false($0/무변경), ② 큐레이션 카탈로그 — 우리가 `MCP_SERVER_TARGETS`에 넣은 벤더만 `preset_key`를 가진다(임의 URL 등록 UI 없음, `custom_mcp` 폐기 유지), ③ 프리셋별 fail-closed `official_mcp_read_only_ack[preset_key]` — 값은 운영자가 검증한 **엔드포인트 URL 그대로**(불리언 `true`가 아니다. `map(string)`이며 provision.py는 `ack[preset_key] == official_mcp_endpoints[preset_key]`를 비교한다). 비어있거나 현재 엔드포인트와 다르면 SKIP + 기존 target 회수, ④ `integrations_write_enabled`가 계속 기본 false라 외부 write 티어 자체가 live가 아니다. 예:
  ```hcl
  official_mcp_endpoints     = { datadog = "https://mcp.datadoghq.com/v1/mcp" }
  official_mcp_read_only_ack = { datadog = "https://mcp.datadoghq.com/v1/mcp" }  # 검토한 엔드포인트를 그대로 echo
  ```
- **[미해결 이탈 ② — ADR-007 §5 / BASELINE §2 do-not-revive] `preset_key` ↔ 엔드포인트 호스트 바인딩은 운영자 주장(operator-asserted)이며 코드로 고정되지 않는다.** 이 항목은 리스크 ①과 성격이 다르므로 "수용된 잔여 리스크"로 적지 **않는다**: ①은 AWS가 API_KEY 경로에 툴 스키마 상한을 제공하지 않는 외부 제약이지만, ②는 우리 코드가 막을 수 있는 것을 막지 않은 것이고, 그 결과가 BASELINE §2가 **do-not-revive** 로 못박은 BYO-MCP 연결과 실질적으로 동일하다. `docs/decisions/CLAUDE.md` 규칙상 그런 불변식의 완화는 **새 ADR + 멀티-AI 패널 + 날짜박힌 owner-override** 를 요구하며, 이 PR 은 그 절차를 밟지 않았다. 따라서 이것은 **승인된 설계 입장이 아니라 미해결 이탈**이며, 아래 수정안이 적용되거나 정식 절차로 완화되기 전까지 열린 항목으로 남는다. **오너 결정(오준석, 2026-07-31): 이 이탈을 연 상태로 머지한다** — 근거는 아래 컨트롤(tfvars/PR 리뷰 게이트)이며, 이 결정 자체가 불변식을 바꾸지는 않는다. 이것은 벤더 제약이 아니라 **우리 쪽 선택**이므로 그대로 기록한다: `official_mcp_endpoints`의 terraform validation은 `https://` **스킴만** 검사하고, ack 검사는 `ack[preset_key] == endpoints[preset_key]`, 즉 운영자 문자열의 **자기 에코**다. 따라서 양쪽 필드에 같은 임의 URL을 쓰면 `datadog` 프리셋을 `https://attacker.example/mcp`에 바인딩할 수 있고, `_ensure_api_key_provider`가 그 target에 해당 프리셋의 실제 자격증명(`mcp:datadog`)을 붙인다 — 비-벤더 호스트로의 자격증명 전달이며, BASELINE §2가 do-not-revive로 못박은 BYO-MCP와 실질적으로 같은 연결이다.
  - **컨트롤:** 두 map 모두 `terraform.tfvars`에 있으므로 이 조작은 **공유 인프라에 `terraform apply`를 할 수 있는 주체**만 가능하다 — 즉 tfvars/PR 리뷰 게이트가 유일한 방어선이고, 그 권한을 가진 주체는 어차피 어떤 target이든 어디로든 향하게 할 수 있다.
  - **원하면 이렇게 고친다:** `catalog.MCP_SERVER_TARGETS`의 프리셋마다 허용 호스트 suffix 튜플을 두고 provision.py에서 불일치 시 fail-closed. 매칭은 **파싱된 hostname의 suffix**로 해야 한다(raw URL `endswith` 금지 — `evil-datadoghq.com`과 `datadoghq.com.attacker.example`가 모두 실패해야 한다). self-host 프리셋(ClickHouse/Grafana/Splunk/Tempo/Jaeger)은 벤더 도메인이 없으므로 정의상 operator-asserted로 남는다.
- **운영 요구사항:** 프리셋을 켠 뒤에도 **벤더의 릴리스 노트/툴 목록 변경을 주기적으로 확인**하고, 스코프가 넓어졌다면 ack를 회수(해당 키 삭제 → 다음 실행에서 자동 retire)한다. 위 리스크 ①에 대한 유일한 실효 대응이다.
- 벤더별 인증 모양이 제각각이라(헤더 2개 요구 등) 프리셋마다 검증이 필요하고, 일부(New Relic 등)는 preview 단계라 변경 가능성이 있다.
- 전환 기간 동안 자체 람다와 원격 target이 공존할 수 있어 kind 단위 순차 전환·상호배제 검증이 필요하다.
- **챗 라우팅은 정적이다(round-3 review MAJOR, 2026-07-31 수정).** `web/lib/route.ts`의 키워드 라우팅은 요청 단위 순수 함수라 `official_mcp_enabled`/ack/endpoint 상태를 런타임에 읽지 않는다 — 벤더별로 legacy lambda target이 없는 kind(Grafana/Datadog/Dynatrace/Splunk/New Relic/Jaeger)는 처음부터 `observability`로 고정 라우팅되지만, **legacy target이 있는 kind(tempo)는 기본(대부분의 배포, `official_mcp_enabled=false`)** 상태의 실제 위치인 `monitoring`으로 라우팅된다. **tempo(또는 향후 동일 패턴의 kind)를 실제로 cutover할 때는 `web/lib/route.ts`에서 해당 키워드를 `monitoring` 규칙에서 `observability` 규칙으로 옮기는 것이 cutover 절차의 REQUIRED 단계다** — 그냥 두면 cutover는 완료됐지만 챗 라우팅은 깨진 채로 영구히 남는다.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: capability=read는 **선언적 라벨이며 서버측 강제가 아니다** — mcpServer target에는 `toolSchema.inlinePayload` 같은 서버측 toolAllowlist 상한이 AWS 쪽에 존재하지 않고(§Trade-offs 리스크 ①), 벤더가 추가한 write 툴은 재-ack 없이 흡수된다. 이는 **수용된 잔여 리스크**이며, 실제로 존재하는 컨트롤은 다음뿐이다: `official_mcp_enabled`·`integrations_enabled` 기본 false, 큐레이션 카탈로그(우리가 등록한 벤더만 `preset_key`를 가짐 — `custom_mcp` 폐기 유지), 프리셋별 fail-closed `official_mcp_read_only_ack`(`map(string)`, 값 = 검토한 엔드포인트 URL 그대로. 기본 `{}` = 미승인 프리셋은 provisioning 거부. 엔드포인트가 바뀌면 ack 불일치 → 자동 retire), `integrations_write_enabled` 기본 false 유지. `official_mcp_endpoints`는 `https://`만 검사한다(Terraform variable validation + provision.py 런타임 재검증, 메타데이터/루프백/링크로컬 리터럴 호스트 차단) — 이는 **평문 http 전송과 오타성 내부 주소를 막을 뿐, 임의 벤더-외 호스트 바인딩을 막지 않는다**(§Trade-offs 리스크 ②: 호스트는 운영자 주장이며 tfvars/PR 리뷰가 유일한 게이트). 또한 실제 egress는 AgentCore-managed 네트워크에서 일어나므로 connect-time SSRF/DNS-rebinding 검증은 우리 코드에 존재하지 않는다. 자격증명은 기존 Secrets Manager 시크릿을 재사용하되 `mcp:<preset_key>` 네임스페이스 키에 저장(같은 슬러그를 쓰는 datasource-connector kind-mirror와 충돌 방지).
- **Operational Excellence**: 벤더 유지보수로 우리 커넥터 코드의 장기 유지보수 부담 감소. `official_mcp_enabled` 기본 false → 게이트 규율(§1) 준수, `plan`=무변경.
- **Reliability**: 기존 SKIP-on-missing-endpoint·멱등 재실행 패턴 재사용 — 전환 실패 시 자체 람다로 즉시 되돌릴 수 있는 롤백 경로 보존(람다 소스 삭제하지 않음).
- **Cost**: default-off=$0. 켜져도 게이트웨이 target 등록 자체는 무료(Lambda 호출 비용만 제거).

---

**관련 BASELINE 갱신:** §2 게이트 register에 `official_mcp_enabled` 추가, §3 인덱스에 ADR-017 추가. 같은 PR.
