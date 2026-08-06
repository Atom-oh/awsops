# ADR-017: 큐레이션 공식 MCP 프리셋 / Curated Official MCP Presets

## Status / 상태
**Accepted (개정 2026-08-05 — owner 지시로 프리셋 전면 재분류).**

게이트 2개, 둘 다 기본 false:
- **`official_mcp_enabled`** (`ai.tf`) — 벤더 **호스팅** 공식 MCP 3종(Datadog·Dynatrace·New Relic)을 external-obs `mcpServer` target으로 등록. 종전 `do-not-enable` 이었던 활성화 차단 사유 2개는 이번 개정으로 해소되었다: ① 런타임 per-preset 툴 allowlist가 구현됨(아래 §Decision — fail-closed), ② 자체 호스팅 프리셋이 이 경로에서 **제거**되어 도달성 미검증 문제 자체가 소멸(남은 3종은 공용 SaaS 엔드포인트). 이제 일반 GATED — 켜려면 선행조건 `agentcore_enabled`+`integrations_enabled`(둘 다 없으면 silent SKIP)에 더해 프리셋별 `official_mcp_read_only_ack`(fail-closed)까지 필요하다.
- **`CLICKHOUSE_OFFICIAL_MCP`** (AgentCore 런타임 env, provisioner가 기록 — `CLICKHOUSE_OFFICIAL_MCP=true make agentcore`) — ClickHouse 공식 MCP(`mcp-clickhouse`)를 런타임 컨테이너에 **stdio로 내장** 실행. 기본 off이며, **do-not-enable**: 자체 람다 경로(`agent/lambda/clickhouse_mcp.py`)의 1차 방어(테이블 함수 SSRF 차단 `_TABLE_FN` + ClickHouse `readonly=1` + connect-time `assert_host_allowed`)를 stdio 경로는 대체 없이 갖지 못한다(아래 §Trade-offs) — `ALLOW_WRITE_ACCESS=false`/`ALLOW_DROP=false` 코드 고정만으로는 동등하지 않다. 
  **분류 = FROZEN**(BASELINE §2 register 2-티어 중 FROZEN — GATED가 아니다. 리뷰 2026-08-05, PR #207). 즉 "거버넌스 하에 켤 수 있는 기능"이 아니라 **동결**이며, 아래 두 조건을 **모두** 만족해야 해제된다:
  1. **기술 선결조건** — stdio 앞단의 동등한 쿼리 가드(`_TABLE_FN` 급 테이블 함수 차단 + connect-time DNS-rebinding-safe host 검증) **또는** ClickHouse 서버측 최소권한 롤/프로필로 테이블 함수 자체를 비활성. 둘 중 하나가 코드/서버에 존재하고 테스트로 고정되어야 한다.
  2. **거버넌스 절차** — BASELINE §2의 FROZEN 해제 절차와 동일: **새 ADR**(본 ADR의 이 판정을 명시 번복) + **멀티-AI 패널 리뷰** + **날짜박힌 owner-override**. 문서 정리·재해석·이 ADR의 in-place 수정으로는 풀지 않는다.

  terraform flag가 아닌 런타임 env 게이트라는 점은 분류를 약화시키지 않는다 — `make agentcore`가 기록하는 provisioner 입력이므로 동일하게 default-off invariant의 대상이다.

- **Owner 지시 1:** 오준석(Junseok Oh), 2026-07-29 — "우리가 만든 mcp는 앞으로 유지보수가 걸림돌이 될거 같아서 외부에서 잘 관리되는 mcp가 맞는거 같아서, 다만 유명한 데이터 소스의 mcp를 우리가 먼저 정해주는게 좋긴 할거 같아".
- **Owner 지시 2:** 오준석, 2026-08-05 — 초기 구현(토큰만 받는 커넥터 카드 + 운영자가 MCP 서버를 직접 호스팅하는 원격 target 모델)은 의도가 아니었다. "공식 MCP는 token으로만 등록되어 있는 것이 문제 — 실제로 사용 불가능한 UX. 공식 MCP를 넣어달라고 한 것은 직접 만든 clickhouse mcp보다 schema 등 API 연결이 잘 될 것을 기대해서. 어딘가에 mcp 서버를 띄우고 관리하는 것은 원한 게 아님." → 본 개정.

이는 ADR-005 autonomy freeze의 예외가 아니다 — 대상은 **외부 DATA read**(ADR-007 관할)이며, AWS 리소스 변경도 자율 조치도 아니다.

## Context / 컨텍스트

초기 구현(2026-07-31)은 8개 벤더 전부를 "원격 `mcpServer` target + 토큰 1개 붙여넣기" 모델로 다뤘다. 2026-08-05 전수 감사 결과 이 모델은 벤더 계열에 따라 성립 여부가 갈렸다:

- **벤더 호스팅 (Datadog·Dynatrace·New Relic)** — 벤더가 원격 MCP 엔드포인트를 직접 운영하고 단일 헤더 토큰 인증을 지원한다(벤더별 형태는 상이 — bearer 또는 New Relic의 무접두 `Api-Key`)(벤더 문서 검증 2026-08-05: Datadog PAT/SAT bearer 또는 DD 키쌍, Dynatrace platform-token bearer `https://<env>.apps.dynatrace.com/platform-reserved/mcp-gateway/...`, New Relic `Api-Key` @ `https://mcp.newrelic.com/mcp/`). **토큰 모델이 성립하는 유일한 계열.**
- **자체 호스팅 (ClickHouse·Grafana·Splunk)** — 벤더 공식 MCP가 "서버 프로그램"으로만 배포된다. 운영자가 어딘가에 띄워야 하고, 서버 자체에 토큰 발급/검증 기능이 없어(예: `mcp-clickhouse`는 DB 접속정보를 서버측 env로 받음) "토큰 붙여넣기" UI에 대응하는 벤더 기능이 존재하지 않았다. 게다가 AgentCore 관리형 네트워크에서 in-VPC 사설 엔드포인트 도달성은 미검증이었다. **원격 target 모델로는 구조적으로 사용 불가.**
- **인-바이너리 (Tempo·Jaeger)** — 공식 MCP가 Tempo/Jaeger 바이너리 안에 내장된 서버측 기능이라 별도로 띄울 수도, 내장할 수도 없다. 앞단 인증을 상속할 뿐 자체 토큰도 없다.
- 한편 ClickHouse 등 자체 호스팅 계열의 접속정보(endpoint/user/password)는 **이미 Datasources UI에 등록**되어 있고(`integrations` kind-mirror, ADR-039), 직접 작성한 Lambda MCP가 그것으로 동작 중이었다 — 초기 구현은 이 기존 자산과 전혀 연결되지 않는 별도 토큰을 요구했다.

AgentCore 런타임은 VPC 모드(ENI in our VPC)로 돌 수 있으므로, 런타임 컨테이너 **안에서** stdio로 실행되는 공식 MCP 서버는 in-VPC 데이터소스에 자연히 도달한다 — 원격 target 모델이 못 풀던 도달성이 구조적으로 해결된다.

Prometheus·Mimir는 공식 MCP가 없어(2026-07 조사) 자체 람다 유지, Notion hosted MCP는 OAuth 3LO 전용이라 기존 토큰 방식 유지 — 변동 없음.

## Decision / 결정

**공식 MCP는 벤더 계열별로 다른 경로를 쓴다. 임의 사용자 지정 MCP 엔드포인트(BYO-MCP)는 계속 폐기(do-not-revive).**

1. **원격 `mcpServer` 프리셋 = 벤더 호스팅 3종만** (`catalog.py MCP_SERVER_TARGETS`: datadog·dynatrace·newrelic). 자체 호스팅 5종(clickhouse/tempo/jaeger/grafana/splunk)은 카탈로그에서 **제거**. 엔드포인트는 계속 데이터(`official_mcp_endpoints` tfvars — Datadog은 사이트별, Dynatrace는 환경별이라 상수화 불가), `allowed_host_suffixes` 핀 + `official_mcp_read_only_ack[preset_key] == endpoint` fail-closed는 유지.
2. **런타임 per-preset 툴 allowlist (fail-closed)** — 종전 활성화 차단 사유 ①의 해소. 카탈로그 각 프리셋이 `tool_allowlist`(벤더 문서에서 **전사**한 read-only 툴 이름, 전사 일자·URL 주석 필수 — 추측 금지)를 선언하고, provision.py가 `OFFICIAL_MCP_TOOL_ALLOWLIST_JSON` 런타임 env로 기록하며, `agent.py`가 게이트웨이 툴 중 `*-mcp-server-target___<tool>` 이름을 이 집합과 교집합한다. **빈/미전사 allowlist ⇒ 그 프리셋 툴 0개**(Dynatrace는 hosted 툴 목록이 문서에 미공개라 공란 — 운영자가 전사해 채우기 전까지 툴 없음). env 부재 시에도 `-mcp-server-target___` 접두 툴은 전부 드랍(fail-closed). 벤더가 write 툴을 추가해도 allowlist 밖이므로 흡수되지 않는다 — 종전의 "재-ack 없이 흡수" 리스크가 코드로 닫혔다.
3. **ClickHouse = 공식 `mcp-clickhouse`를 런타임에 stdio 내장** (owner 기대의 본체). agent 이미지에 `mcp-clickhouse` 패키지를 포함하고, `CLICKHOUSE_OFFICIAL_MCP=true`일 때 external-obs 게이트웨이 호출에서 런타임이 stdio 서브프로세스로 spawn한다. 접속정보는 **기존 Datasources 등록을 그대로 재사용** — integrations secret의 `clickhouse` kind-mirror(endpoint/username/password)를 런타임이 읽어(`ops/<project>/integrations/*` GetSecretValue는 기존 grant) `CLICKHOUSE_HOST/PORT/USER/PASSWORD/SECURE` env로 주입한다. **주의**: 이 env 계약은 basic/none 인증과 host[:port] 엔드포인트만 표현한다 — bearer/custom_header 인증이나 경로 접두 엔드포인트로 등록된 datasource는 stdio 툴 0개로 fail-closed되고 자체 람다 경로가 계속 서빙한다. 신규 토큰·신규 서버·terraform 변경 없음. **read-only 강제**: `CLICKHOUSE_ALLOW_WRITE_ACCESS=false`·`CLICKHOUSE_ALLOW_DROP=false`를 코드에서 고정(운영자 설정으로 뒤집을 수 없음). stdio 연결이 **성공한 턴**에는 같은 게이트웨이의 자체 람다 clickhouse 툴(`clickhouse-mcp-target___*`)을 런타임에서 드랍 — 이중 노출 방지(상호배제를 툴 레이어에서). 연결 실패 시엔 람다 툴이 그대로 살아 서빙 공백이 없다.
4. **Tempo = 자체 람다 target 유지** (공식 MCP가 인-바이너리라 대체 불가 — `catalog.py TARGETS`의 `tempo-mcp-target`이 현행 챗 경로). **Jaeger = 현재 챗 경로 없음** — `jaeger-mcp` 람다는 `ai.tf`에 배포되어 있으나 게이트웨이 target으로 **등록된 적이 없고**(`TARGETS`에 항목 부재 — `legacy_target_name()` docstring이 명시), 이 개정은 그 상태를 바꾸지 않는다. target 등록 여부는 실수요 발생 시 별도 결정. **Grafana·Splunk = 지원하지 않음** — 커넥터 카드 삭제. Grafana stdio 내장(Go 바이너리)은 실수요 발생 시 별도 결정, Splunk 공식 MCP는 사용자의 Splunk 인스턴스 안에 설치되는 서버측 앱이라 우리 쪽에서 성립하는 경로가 없다.
5. **커넥터 UI 정직화** — Connectors 탭 카드는 Notion(동작) + 벤더 호스팅 3종(게이트됨 배지, 토큰 사전 등록만 가능함을 명시)만. 자체 호스팅 계열 카드는 삭제하고 Datasources 탭이 유일한 등록 지점.

## Consequences / 결과

### Positive / 긍정
- ClickHouse는 별도 서버·토큰·terraform 없이 공식 MCP의 스키마 툴(`list_databases`/`list_tables`/`run_select_query`)을 얻는다 — 기존 Datasources 등록만으로. 커넥터 코드 유지보수가 벤더로 넘어간다.
- "토큰 붙여넣기" 카드가 실제로 성립하는 벤더(호스팅 3종)에만 남는다 — dead UI 8종 → 0.
- 벤더 write 툴 추가가 allowlist에 막힌다(fail-closed) — 종전 CRITICAL 잔여 리스크 해소.

### Negative / Trade-offs
- stdio 내장은 공식 MCP 서버 버전을 **우리 이미지 빌드에 고정**한다 — 벤더 업데이트를 받으려면 agent 이미지 재빌드(`make agentcore`). 원격 모델의 "항상 최신"과 반대 방향의 trade-off이며, 대신 툴 surface가 빌드 시점에 고정되는 것은 보안상 이점.
- stdio spawn은 게이트웨이 호출당 서브프로세스 기동 비용(수백 ms)을 더한다 — external-obs 경로에서만, 플래그 ON일 때만.
- Dynatrace 프리셋은 hosted 툴 목록 전사 전까지 툴 0개로 provisioning된다(의도된 fail-closed).
- **런타임 readiness 게이트의 운영 동작 (리뷰 MAJOR 문서화, 2026-08-06):** `make agentcore`에서 런타임 create/update 후 provisioner가 READY를 폴링한다(기본 300s, `AGENTCORE_RUNTIME_READY_TIMEOUT` env로 조정). 롤아웃이 실패하거나 타임아웃하면 그 run은 **자격을 갖춘(endpoint+ack+credential) 프리셋의 live target까지 회수(retire)한다** — allowlist를 싣지 않은 구 런타임이 벤더 툴 전부를 무필터로 서빙하는 것을 막기 위한 fail-closed이며, 다음 성공 run이 target/provider를 멱등 재생성한다. 즉 운영자 관점에서 "make agentcore 실패 → Datadog 연동이 일시적으로 사라짐 → 성공 run에서 복귀"는 의도된 동작이다(ERR 로그로 고지). 업데이트 대기 중 구 런타임이 잠시 기존 target을 서빙하는 과도 창(1회 롤아웃 한정)은 **기록된 수용 리스크**다 — base는 영구 노출이었으므로 이 PR은 모든 시나리오에서 노출을 순감소시킨다; retire-before-update로 창 자체를 없애는 것은 acked target flapping과의 트레이드오프로 채택하지 않았다.
- 제거된 프리셋 5종의 잔여물 정리는 수동이다: Connectors 카드로 저장된 `mcp:<slug>` 시크릿 키(clickhouse/tempo/jaeger/grafana/splunk)는 API가 GET/PUT뿐이라 남아 있고(런타임 역할이 읽을 수 있음 — 능동 노출 경로는 아님), tfvars의 구 `official_mcp_endpoints`/`official_mcp_read_only_ack` 항목도 무해하나 stale하다. 운영자가 Secrets Manager에서 해당 키 삭제 + tfvars 정리를 1회 수행할 것.
- 멀티 인스턴스 datasource(ADR-039)의 비-default 인스턴스는 stdio 경로가 아직 읽지 않는다(kind-mirror=default 인스턴스만). 필요 시 후속.
- **stdio ClickHouse는 자체 람다 경로의 1차 방어를 대체 없이 잃는다(리뷰 2026-08-05, PR #207 — do-not-enable 사유).** `agent/lambda/clickhouse_mcp.py`는 `url`/`file`/`remote`/`s3`/`mysql` 등 ClickHouse 테이블 함수가 "`readonly=1`이 막지 못하는 server-side SSRF/cross-datastore exfil 벡터"임을 명시하고 `_TABLE_FN` 정규식 차단 + 쿼리에 `?readonly=1` 강제 + 요청마다 DNS-rebinding-safe `assert_host_allowed()`로 막는다(`agent/lambda/CLAUDE.md`: "ClickHouse 커넥터는 DB-롤 경계가 없어 어휘 가드가 1차 방어"). 공식 `mcp-clickhouse` stdio 서브프로세스는 이 세 가지 중 아무것도 갖지 않는다 — `CLICKHOUSE_ALLOW_WRITE_ACCESS=false`/`ALLOW_DROP=false` env 2개와 URL scheme 검사만 남는다. 프롬프트 인젝션된 에이전트가 `SELECT * FROM url('http://169.254.169.254/...')` 류로 in-VPC/메타데이터에 도달할 수 있는 경로가 코드상 존재하며, 기본 off인 것이 유일한 방어다. 동등한 쿼리 가드(또는 ClickHouse 서버측 최소권한 롤/프로필로 테이블 함수 자체를 비활성)가 갖춰지기 전까지 `CLICKHOUSE_OFFICIAL_MCP`는 **do-not-enable**이다 — §Status 갱신, BASELINE §2 동기화(같은 PR).
- 챗 라우팅 정적성 주의는 유지: legacy lambda target이 있는 kind를 원격 프리셋으로 cutover할 때 `web/lib/route.ts` 키워드 이동이 REQUIRED 단계다(현재 남은 대상: 없음 — tempo가 카탈로그에서 빠져 cutover 시나리오 자체가 소멸). 같은 규칙의 역방향도 이 개정에서 집행했다: 챗 경로가 소멸한 kind(grafana/splunk/jaeger)의 키워드를 observability 규칙에서 제거 — 벤더명이 라우팅 신호이길 멈춘다는 뜻이며(강제 general 아님), 잔여 도메인 키워드는 도메인대로(예: 트레이스→monitoring), 무매치는 ops catch-all/LLM 분류기로 간다.
- **operator-asserted(자체 호스팅) 프리셋의 host-pin 규칙은 코드·테스트로 보존한다(현재 해당 프리셋 0건).** 이번 개정으로 카탈로그에서 자체 호스팅 프리셋이 전부 빠졌지만, `provision.py::_host_pin_violation`의 사설 IP 리터럴 강제(이름 금지 — 이름은 프로비저닝 후 공용으로 재지정 가능하고 AgentCore-managed egress라 재검증 기회가 없다; 허용 대역은 명시적 in-VPC 목록 — `ipaddress.is_private`는 6to4/Teredo 전환 주소를 통과시킨다)는 미래의 operator-asserted 프리셋을 위한 fail-closed 분류기로 유지되며 `test_provision_host_pin.py`가 합성 스펙으로 고정한다. 근거 상세는 개정 전 본문(git 이력 `docs/decisions/017-*.md`, 2026-07-31판 §Trade-offs ②) 참조.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: 원격 프리셋의 read 강제 = 벤더측 컨트롤 ack(`official_mcp_read_only_ack`, fail-closed) **+ 런타임 툴 allowlist(fail-closed, 코드 강제)** 2중, 그리고 이 allowlist는 `agent.py`(Strands 경로)와 `anthropic_loop.py`(다크 경로) 양쪽 모두에서 동일하게 강제된다(공유 헬퍼 — 리뷰 2026-08-05 CRITICAL 수정, PR #207). stdio ClickHouse의 read 강제는 `CLICKHOUSE_ALLOW_WRITE_ACCESS=false`/`ALLOW_DROP=false` 코드 고정뿐이다 — **ClickHouse `readonly=1`이 아니다**: 그 서버측 파라미터는 자체 람다 경로(`clickhouse_mcp.py`)에만 존재하고, `mcp-clickhouse` stdio env 계약에는 대응 항목이 없다(정정, 이전 판이 잘못 주장함). 테이블 함수 SSRF 차단도 stdio 경로에 없다 — 위 §Trade-offs 참조, 이 gap이 `CLICKHOUSE_OFFICIAL_MCP`를 do-not-enable로 유지하는 이유다. 자격증명은 기존 Secrets Manager 재사용(신규 저장소 없음), stdio env로만 전달(로그 금지). BYO-MCP 폐기 유지.
- **Operational Excellence**: 커넥터 유지보수의 벤더 이관(ClickHouse 스키마 툴 등), dead UI 제거로 운영자 혼란 제거.
- **Reliability**: stdio spawn 실패는 게이트웨이 툴에 영향 없이 해당 툴만 결손(기존 integration 격리 패턴과 동일). 자체 람다는 삭제하지 않아 롤백 경로 보존.
- **Cost**: 두 게이트 모두 default-off = $0. stdio는 추가 인프라 없음(런타임 컨테이너 내 실행).

---

**관련 BASELINE 갱신:** §2 register — `official_mcp_enabled` 항목 재기술(do-not-enable 해제, 대상 3종, allowlist 강제) + `CLICKHOUSE_OFFICIAL_MCP` 게이트 추가. 같은 PR.
