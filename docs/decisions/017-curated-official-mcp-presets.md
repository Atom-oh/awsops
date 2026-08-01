# ADR-017: 큐레이션 공식 MCP 프리셋 / Curated Official MCP Presets

## Status / 상태
**Accepted — 단, `integrations_enabled` 프리셋 경로는 `do-not-enable`(GATED, 활성화 금지).**

활성화 전제조건 2개가 아직 충족되지 않았다(PR #194 리뷰, CRITICAL×2·MAJOR×1):

1. **런타임 per-preset 툴 allowlist가 없다.** `mcpServer` target 은 `listingMode=DEFAULT` 로 벤더가 광고하는 툴 **전부(write 툴 포함)** 를 노출하고, AWS 는 API_KEY 경로에 상한 필드를 제공하지 않는다(§Trade-offs ①). 유일하게 남은 강제 지점은 **우리 런타임**이다 — `agent/agent.py:get_all_tools()` 가 게이트웨이 툴을 받는 관문이므로, 거기서 `<target>___<tool>` 이름을 프리셋별 ack 된 툴 집합과 교집합(fail-closed, 빈 집합 ⇒ 툴 없음)해야 한다. 이는 이미 egress-READ 인티그레이션에 쓰는 `select_integration_tools()` 와 동일한 형태다. 그 allowlist는 **벤더 문서에서 옮겨 적어야** 하며 추측으로 채우면 안 된다(틀리면 fail-closed 로 기능이 죽고, 느슨하면 통제가 없다).
2. **자체 호스팅 프리셋의 도달성이 미검증이다.** 아래 host-pin 규칙은 사설 IP 리터럴을 요구하는데, `mcpServer` 호출은 AgentCore 관리형 네트워크에서 나가므로 VPC 사설 대역에 도달하지 못할 가능성이 있다(리뷰 MAJOR). 도달성을 실측하기 전까지 ClickHouse/Grafana/Splunk/Tempo/Jaeger 프리셋은 동작이 보장되지 않는다.

두 조건이 충족되고 그 변경이 리뷰를 통과할 때까지 이 경로는 켜지 않는다. flag-OFF substrate 는 보존한다(삭제 아님) — BASELINE §2 GATED 항목과 같은 취급.

- **Owner 지시:** 오준석(Junseok Oh), 2026-07-29 — "우리가 만든 mcp는 앞으로 유지보수가 걸림돌이 될거 같아서 외부에서 잘 관리되는 mcp가 맞는거 같아서, 다만 유명한 데이터 소스의 mcp를 우리가 먼저 정해주는게 좋긴 할거 같아". 이는 ADR-005 autonomy freeze의 예외가 아니다 — 대상은 **외부 DATA read**(ADR-007 관할, read-only 정의 밖)이며, AWS 리소스 변경도 자율 조치도 아니다.

## Context / 컨텍스트

`/integrations` 허브의 Connectors 탭은 Notion 1개만 하드코딩돼 있고(`web/app/integrations/connectors/ConnectorsTab.tsx`), `custom_mcp`라는 kind는 enum·DB CHECK에 존재하고 `/customization` 고급 폼의 kind 드롭다운에도 선택 가능한 옵션으로 이미 노출돼 있었다(`INTEGRATION_KINDS_EGRESS`를 그대로 렌더링하므로) — 다만 그 문자열을 분기해 실제로 무언가를 하는 런타임 코드는 하나도 없었다(round-2 review 정정, 2026-07-31: 선택은 가능했지만 기능은 없는 상태였다는 것이 정확한 표현이며, "UI에 노출되지 않았다"는 이전 표현은 부정확했다).

한편 Prometheus/ClickHouse는 이미 MCP다: `agent/lambda/{prometheus,clickhouse}_mcp.py`가 external-obs 게이트웨이의 `mcp.lambda` target으로 등록돼 있다(`scripts/v2/agentcore/catalog.py`). 이 두 관찰을 검토한 결과 실제 문제는 프로토콜이 아니라 **우리가 커넥터 코드(HTTP 클라이언트, 인증 헤더, SQL/PromQL 가드)를 직접 작성·유지보수하고 있다는 점**이었다. Datadog·ClickHouse·Tempo·Jaeger v2·Grafana·Dynatrace·Splunk 등은 이미 벤더가 공식 MCP 서버를 배포 중이고, AWS Bedrock AgentCore Gateway는 `McpServerTargetConfiguration`으로 원격 MCP 엔드포인트를 target으로 등록하는 것을 정식 지원한다(outbound auth: none/OAuth 2LO/3LO/SigV4/API key) — 지금까지 쓰던 `mcp.lambda` target 타입 외에 두 번째 target 타입이 이미 AWS 쪽에 존재한다.

Prometheus·Mimir는 조사 시점(2026-07) 공식 MCP가 없어(community만 존재) 자체 람다를 유지해야 하고, Notion의 hosted MCP는 OAuth 3LO 전용이라 헤드리스 진단 경로에 쓸 수 없어 현행 토큰 방식을 유지한다.

## Decision / 결정

**큐레이션·타입드 공식 벤더 MCP 프리셋을 external-obs 게이트웨이의 `mcpServer` target으로 등록할 수 있게 한다. 임의 사용자 지정 MCP 엔드포인트(BYO-MCP) 등록은 계속 폐기(do-not-revive) 상태로 둔다.**

- **새 substrate가 아니다** — 기존 external-obs 게이트웨이를 그대로 쓴다. `scripts/v2/agentcore/catalog.py`에 원격 MCP 프리셋 카탈로그(`MCP_SERVER_TARGETS`)를 추가하고, `provision.py`가 `targetConfiguration = {"mcp": {"mcpServer": {"endpoint": ..., "listingMode": "DEFAULT"}}}` 형태로 생성한다. 기존 `TARGETS`(`mcp.lambda`)와 병존하되, 같은 kind가 두 target 타입에 동시에 존재할 수 없다(툴 이름 중복·비결정적 dedup 방지).
- **엔드포인트는 데이터, 코드가 아니다** — `official_mcp_endpoints`(map, 기본 `{}`) + `official_mcp_enabled`(bool, 기본 **false**) terraform 변수로 배포별 실제 URL을 주입한다. 미설정 프리셋은 SKIP·exit 0(기존 flag-off 패턴과 동일). **`preset_key` ↔ 호스트 바인딩은 벤더 호스팅 프리셋에 한해 카탈로그의 `allowed_host_suffixes` 로 코드에서 강제된다**(불일치 시 fail-closed). 자체 호스팅 프리셋은 핀할 벤더 도메인이 없어 `host_is_operator_asserted=True` 로 명시하며, 그 경우에만 호스트가 운영자 주장이다 — §Trade-offs ② 참조.
- **큐레이션 대상만** — 공식 MCP가 존재하고 헤드리스(비-브라우저 OAuth) 인증이 가능한 kind만 프리셋화한다(Datadog·ClickHouse self-host·Tempo·Jaeger·Grafana self-host·Dynatrace·Splunk·New Relic-preview). 공식 MCP가 없거나(Prometheus·Mimir) 헤드리스 인증이 불가능한(Notion hosted) kind는 자체 람다/기존 방식을 유지한다.
- **`custom_mcp`(임의 사용자 지정 엔드포인트 등록)는 이 ADR로도 여전히 폐기 상태다** — BASELINE §2의 "폐기(do-not-revive): BYO-MCP" 조항은 변경되지 않는다. 이 ADR이 허용하는 것은 **admin이 미리 정한 벤더 프리셋**일 뿐, 사용자가 URL을 직접 입력하는 경로가 아니다.
- **자격증명**은 신규 저장소를 만들지 않는다 — 기존 `ops/${project}/integrations/credentials` Secrets Manager 시크릿과 `web/lib/integration-credentials.ts`의 advisory-lock 쓰기 경로를 재사용한다.
- **capability는 항상 `read`이지만, 이는 선언적 라벨이며 서버측에서 강제되지 않는다(declarative label, NOT server-side enforcement).** `mcp.lambda` target은 `toolSchema.inlinePayload`로 노출 툴 집합을 하드 리밋하지만, API key 자격증명을 쓰는 `mcpServer` target에는 동등한 상한이 **AWS 쪽에 존재하지 않는다** — 툴 집합을 고정할 수 있는 유일한 필드 `McpServerTargetConfiguration.mcpToolSchema`는 authorization code grant 자격증명에서만 지원된다. 따라서 **이미 ack된 프리셋에 벤더가 write 툴을 추가하면 다음 `make agentcore`에서 재-ack 없이 흡수된다.** AgentCore 가 API_KEY 경로에 툴 스키마 상한을 제공하지 않는 것은 사실이지만, 그렇다고 이것이 **수용 가능한 잔여 리스크가 되지는 않는다** — BASELINE §1 은 외부 DATA write 를 거버넌스(DLP·human-gate·flag) 하에서만 허용하고, ADR 이 그 요건을 단독으로 면제할 수 없다. 따라서 이 항목은 *수용*이 아니라 **활성화 차단 사유**이며, 강제 지점은 게이트웨이가 아니라 우리 런타임이다(§Status 전제조건 1). 쓰기 티어(`integrations_write_enabled`)는 이 ADR의 범위 밖이며 변경하지 않는다(계속 기본 false).

## Consequences / 결과

### Positive / 긍정
- 커넥터별 HTTP 클라이언트/SQL 가드/인증 로직을 벤더가 유지보수 — 프로토콜 변경·버그 대응 부담이 줄어든다.
- 벤더 공식 서버는 대개 우리 손코드보다 툴 커버리지가 넓다(예: Datadog GA 서버, ClickHouse 13개 read-only 툴).
- 큐레이션이므로 ADR-007이 이미 그려둔 "admin 등록 벤더 프리셋만 허용" 라인 안에서 처리된다 — 새 거버넌스 계층이 필요 없다.

### Negative / Trade-offs
- **[미해결 — 활성화 차단 사유 ①] 노출 툴 집합의 결정권은 벤더에게 있고, 벤더가 추가한 write 툴은 재-ack 없이 흡수된다.** Lambda target(`mcp.lambda`)은 `toolSchema.inlinePayload`가 노출 툴 집합을 하드 리밋하지만, `mcpServer` target은 `listingMode=DEFAULT`로 벤더 서버가 광고하는 툴 전부(쓰기 툴 포함)를 그대로 노출하며, provision.py는 매 실행 `synchronize_gateway_targets`를 호출해 현재 상태를 그대로 수용한다. 즉 벤더가 다음 릴리스에 mutating 툴(mute monitor / create incident / delete dashboard 등)을 추가하면 **다음 `make agentcore`에서 재-ack·PR·리뷰 없이 에이전트 툴 surface에 편입된다.** `capability=read`는 이 경로에서 **선언적 라벨이며 서버측 강제가 아니다.**
  - **왜 코드로 막을 수 없는가(외부 제약):** `bedrock-agentcore-control`에는 툴 목록을 읽는 오퍼레이션이 아예 없고(target 관련 오퍼레이션은 `Create/Get/List/Update/DeleteGatewayTarget` + `SynchronizeGatewayTargets`뿐이며 응답에 툴 이름이 없음 — botocore `2023-06-05` 모델 확인) → 스냅샷 비교조차 불가능하다. 툴 집합을 고정할 수 있는 유일한 필드 `McpServerTargetConfiguration.mcpToolSchema`는 AWS 문서상 **authorization code grant 자격증명에서만 지원**되고(이 프리셋들은 API key) 설정 시 툴 동기화 자체가 비활성화된다.
  - **수용하지 않는다 — 활성화를 막는다(§Status).** 이전 리비전은 이를 "알고서 수용한 잔여 리스크"로 적었는데, 그것이 BASELINE §1 과 정면으로 충돌했다(리뷰 CRITICAL). 외부 제약은 게이트웨이에서 막을 수 없다는 것까지만 참이고, 우리 런타임에서 막을 수 있다는 사실을 덮지 못한다. 단 이것이 ADR-007 §5 의 "curation = 기술적으로 강제되는 provenance" 요건을 충족한다는 뜻은 아니다 — 충족하지 못하며, AWS 가 API_KEY 경로에 상한을 제공하지 않는 한 우리 코드로 충족시킬 방법이 없다. `read_only_note`(catalog.py)와 ack는 **툴 목록이 아니라 벤더측 컨트롤**(RBAC 스코프 / `--disable-write` / read-scoped 토큰)에 대한 attestation이며, 그 컨트롤은 나중에 추가되는 툴에도 계속 적용된다 — 그러나 그 이상은 보장하지 않는다.
  - **보상 컨트롤(존재하는 것만 적는다):** ① `official_mcp_enabled` + `integrations_enabled` 기본 false($0/무변경), ② 큐레이션 카탈로그 — 우리가 `MCP_SERVER_TARGETS`에 넣은 벤더만 `preset_key`를 가진다(임의 URL 등록 UI 없음, `custom_mcp` 폐기 유지), ③ 프리셋별 fail-closed `official_mcp_read_only_ack[preset_key]` — 값은 운영자가 검증한 **엔드포인트 URL 그대로**(불리언 `true`가 아니다. `map(string)`이며 provision.py는 `ack[preset_key] == official_mcp_endpoints[preset_key]`를 비교한다). 비어있거나 현재 엔드포인트와 다르면 SKIP + 기존 target 회수, ④ `integrations_write_enabled`가 계속 기본 false라 외부 write 티어 자체가 live가 아니다. 예:
  ```hcl
  official_mcp_endpoints     = { datadog = "https://mcp.datadoghq.com/v1/mcp" }
  official_mcp_read_only_ack = { datadog = "https://mcp.datadoghq.com/v1/mcp" }  # 검토한 엔드포인트를 그대로 echo
  ```
- **[해소됨 ②] `preset_key` ↔ 엔드포인트 호스트 바인딩은 카탈로그의 프리셋별 allowlist 로 코드에서 강제된다.** 이전 리비전은 이것을 "수용된 잔여 리스크"로 적었는데, 그 결과가 BASELINE §2 가 **do-not-revive** 로 못박은 BYO-MCP 연결과 실질적으로 동일했으므로 문서로 수용할 수 있는 사안이 아니었다(그런 완화는 새 ADR + 패널 + owner-override 를 요구한다). 이제 막는다: `catalog.MCP_SERVER_TARGETS` 의 각 프리셋은 **정확히 하나**를 선언한다 — 벤더 호스팅이면 `allowed_host_suffixes`(datadog `.datadoghq.com`/`.datadoghq.eu`/`.ddog-gov.com`, newrelic `.newrelic.com`, dynatrace `.dynatrace.com`), 자체 호스팅이면 `host_is_operator_asserted=True`(ClickHouse/Grafana/Splunk/Tempo/Jaeger — 핀할 벤더 도메인이 존재하지 않는다). 둘 다 없는 항목은 카탈로그 버그로 **fail-closed**("확인 불가"와 "자체 호스팅"을 같은 상태로 뭉개지 않는다). 매칭은 **파싱된 hostname 의 suffix** 로 하므로 `evil-datadoghq.com`(점 경계 없음)과 `datadoghq.com.attacker.example`(suffix 가 중간)이 모두 거부된다 — raw URL `endswith` 는 둘 다 통과시킨다. Dynatrace **Managed** 는 고객 도메인에 자체 호스팅되므로 이 핀에 포함되지 않는다: 그 배포는 이 preset key 를 재사용하면 안 되고 별도 operator-asserted 항목이 필요하다.
  - **자체 호스팅 5종도 임의 호스트를 허용하지 않는다.** `host_is_operator_asserted` 만으로는 여전히 어떤 호스트든 받아 자격증명을 넘겼으므로, 이름만 바뀐 같은 BYO-MCP 구멍이었다. 이들은 설계상 in-VPC 이므로 아래 규칙으로 강제한다.
  - **자체 호스팅 프리셋은 사설 IP 리터럴만 받는다.** 이름은 받지 않는다 — 이름이 바로 유출을 가능하게 하는 요소다: 프로비저닝 시점엔 사설로 해석되지만 이후 공용으로 재지정할 수 있고, 실제 연결은 AgentCore 관리형 네트워크가 나중에 맺으므로 우리에게 재검증 기회가 없다. 즉 **이름을 검증하는 것은 무엇에 연결될지에 대해 아무것도 증명하지 못한다.** 리터럴은 뒤에 DNS 가 없으므로 검증한 값이 곧 연결되는 값이다. 허용 대역은 **명시적 허용목록**(RFC1918 10/8·172.16/12·192.168/16 + IPv6 ULA fc00::/7)이다 — `ipaddress.is_private` 로 판정하지 않는다. 그 술어는 6to4/Teredo 주소에 **임베드된** IPv4 로 답하기 때문에 `2002:5db8:d822::1`(공용 93.184.216.34 를 감싼 6to4)이 `is_private=True` 로 나오면서 실제로는 공용 인터넷으로 라우팅된다 — 이 게이트가 막으려는 유출 그 자체를 통과시킨다. 허용목록 방식은 모든 전환 주소 형식(6to4·Teredo·IPv4-mapped·NAT64)을 구조적으로 배제하므로 형식별 차단 목록을 유지할 필요가 없다. AWS VPC 의 IPv6 CIDR 은 공용 라우팅 GUA 라서 의도적으로 제외한다 — 주소만으로는 유출 대상과 구별되지 않는다.
  - **이 선택으로 사라진 것들:** 이전 리비전들이 "기록된 잔여"로 적었던 항목 대부분이 실제로는 닫을 수 있는 것이었다 — rebinding/TOCTOU 창(DNS 가 없으므로 존재하지 않음), 해석 실패 시 fail-open, 그리고 `official_mcp_self_hosted_host_suffixes` 라는 설정 레이어 자체(운영자가 공격자 도메인을 "내부"로 선언할 수 있었으므로 게이트가 아니었다 — 변수를 삭제했다). 문서화를 수정의 대체물로 쓴 것이 실수였다.
  - **남는 것:** 통제 중인 사설 대역 안의 다른 호스트로 바꾸는 것. 그 대역을 통제하는 주체는 이미 신뢰 경계 안이며, 이는 설정이 아니라 네트워크 소유권의 문제다. 운영상 비용: 자체 호스팅 엔드포인트의 IP 가 바뀌면 tfvars 를 갱신해야 한다 — 자격증명을 넘기는 경로이므로 의도된 마찰이다.

- **운영 요구사항:** 프리셋을 켠 뒤에도 **벤더의 릴리스 노트/툴 목록 변경을 주기적으로 확인**하고, 스코프가 넓어졌다면 ack를 회수(해당 키 삭제 → 다음 실행에서 자동 retire)한다. 위 리스크 ①에 대한 유일한 실효 대응이다.
- 벤더별 인증 모양이 제각각이라(헤더 2개 요구 등) 프리셋마다 검증이 필요하고, 일부(New Relic 등)는 preview 단계라 변경 가능성이 있다.
- 전환 기간 동안 자체 람다와 원격 target이 공존할 수 있어 kind 단위 순차 전환·상호배제 검증이 필요하다.
- **챗 라우팅은 정적이다(round-3 review MAJOR, 2026-07-31 수정).** `web/lib/route.ts`의 키워드 라우팅은 요청 단위 순수 함수라 `official_mcp_enabled`/ack/endpoint 상태를 런타임에 읽지 않는다 — 벤더별로 legacy lambda target이 없는 kind(Grafana/Datadog/Dynatrace/Splunk/New Relic/Jaeger)는 처음부터 `observability`로 고정 라우팅되지만, **legacy target이 있는 kind(tempo)는 기본(대부분의 배포, `official_mcp_enabled=false`)** 상태의 실제 위치인 `monitoring`으로 라우팅된다. **tempo(또는 향후 동일 패턴의 kind)를 실제로 cutover할 때는 `web/lib/route.ts`에서 해당 키워드를 `monitoring` 규칙에서 `observability` 규칙으로 옮기는 것이 cutover 절차의 REQUIRED 단계다** — 그냥 두면 cutover는 완료됐지만 챗 라우팅은 깨진 채로 영구히 남는다.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: capability=read는 **선언적 라벨이며 서버측 강제가 아니다** — mcpServer target에는 `toolSchema.inlinePayload` 같은 서버측 toolAllowlist 상한이 AWS 쪽에 존재하지 않고(§Trade-offs 리스크 ①), 벤더가 추가한 write 툴은 재-ack 없이 흡수된다. 이는 **수용된 잔여 리스크**이며, 실제로 존재하는 컨트롤은 다음뿐이다: `official_mcp_enabled`·`integrations_enabled` 기본 false, 큐레이션 카탈로그(우리가 등록한 벤더만 `preset_key`를 가짐 — `custom_mcp` 폐기 유지), 프리셋별 fail-closed `official_mcp_read_only_ack`(`map(string)`, 값 = 검토한 엔드포인트 URL 그대로. 기본 `{}` = 미승인 프리셋은 provisioning 거부. 엔드포인트가 바뀌면 ack 불일치 → 자동 retire), `integrations_write_enabled` 기본 false 유지. `official_mcp_endpoints`는 `https://` 스킴 + 메타데이터/루프백/링크로컬 리터럴 호스트 차단(Terraform variable validation + provision.py 런타임 재검증)에 더해, **벤더 호스팅 프리셋은 `allowed_host_suffixes` 로 호스트가 코드에서 핀된다**(파싱된 hostname suffix 매칭, 불일치 시 fail-closed → §Trade-offs ②). 자체 호스팅 프리셋 5종은 벤더 도메인이 없어 호스트가 운영자 주장으로 남고, 그 경우의 게이트는 tfvars/PR 리뷰다. 또한 실제 egress는 AgentCore-managed 네트워크에서 일어나므로 connect-time SSRF/DNS-rebinding 검증은 우리 코드에 존재하지 않는다. 자격증명은 기존 Secrets Manager 시크릿을 재사용하되 `mcp:<preset_key>` 네임스페이스 키에 저장(같은 슬러그를 쓰는 datasource-connector kind-mirror와 충돌 방지).
- **Operational Excellence**: 벤더 유지보수로 우리 커넥터 코드의 장기 유지보수 부담 감소. `official_mcp_enabled` 기본 false → 게이트 규율(§1) 준수, `plan`=무변경.
- **Reliability**: 기존 SKIP-on-missing-endpoint·멱등 재실행 패턴 재사용 — 전환 실패 시 자체 람다로 즉시 되돌릴 수 있는 롤백 경로 보존(람다 소스 삭제하지 않음).
- **Cost**: default-off=$0. 켜져도 게이트웨이 target 등록 자체는 무료(Lambda 호출 비용만 제거).

---

**관련 BASELINE 갱신:** §2 게이트 register에 `official_mcp_enabled` 추가, §3 인덱스에 ADR-017 추가. 같은 PR.
