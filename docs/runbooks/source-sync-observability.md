# Origin observability backport / Origin 관측성 역이식

## Scope / 범위

Backport product content from reviewed `samples/dev`
`0e7579acef9e66fcc3c5976cb846cc1f6780a390` to `origin/main` baseline
`940772e13f33494e512c4a03935b7e4487313c8f`. The source contains the observability
integration and the later merged Tempo query-generation fix.

검토된 samples 소스의 관측성 개선과 이후 병합된 Tempo 쿼리 생성 수정을 origin의 동일
기준 커밋에 내용 단위로 역이식한다. 공개 저장소의 git 이력은 병합하지 않는다.

- Keep origin CI, review scripts, deployment policy, production configuration and private docs.
- Keep the `terraform/v2/foundation/` layout and all existing migration bytes.
- Keep existing branding and links to origin decision/review documents.
- Samples deployment and DNS changes are separate operator tasks.

origin의 CI·리뷰 스크립트·배포 정책·운영 설정·비공개 문서·기존 링크를 유지한다.
samples 배포와 DNS 변경은 별도 작업이다.

## Symptoms and verification / 증상과 확인

Missing observations must not look like healthy traffic, successful work or realized savings.
Service maps disclose failed, partial, empty and stale collection. Jobs disclose acceptance,
first worker start and terminal completion. Tempo drafts use scoped attributes and parser
validation; sampling limits and unavailable schema evidence remain visible.

관측 누락을 정상 트래픽·작업 성공·실제 절감으로 해석하지 않는다. 서비스 맵은 수집 상태를,
작업 화면은 명시된 실행 경계를, Tempo 생성은 속성 범위·문법 검사·관측 제한을 표시한다.

From the repository root / 저장소 루트에서:

```bash
(cd web && npx vitest run)
(cd web && npm run build)
(cd agent/lambda && python3 -m pytest test_tempo_mcp.py test_inventory_read_mcp.py test_aws_finops_mcp.py -q)
python3 -m pytest scripts/v2/workers -q
python3 -m pytest scripts/v2/incident/test_rootcause_rca.py -q
python3 -B -m unittest discover -s scripts/v2 -p test_evaluate_diagnosis.py -v
```

## Migration and rollout / 마이그레이션과 적용

- `01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql`: collection attempts,
  evidence counts and explicitly projected SQL-reader views.
- `01M27AQXZKQQ5J611R01BEFHPD_worker_jobs_lifecycle_timestamps.sql`: first start and terminal
  timestamps, stamped by the existing worker ledger's status transitions.
- `01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql`: queue claimed account/region
  derived only from destination ARN qualifiers and constant `telemetry_claim` provenance in the
  SQL-reader projection, including retained snapshots; idempotent view-only SELECT grant.

These migrations retain the reviewed source bytes and `-- since:` headers. Historical timestamps
are not backfilled. Before migration, workers continue operating and new timing stays unknown;
trace collection waits for its state schema.

세 마이그레이션의 원본 바이트와 릴리스 헤더를 유지한다. 과거 시간을 추정해 채우지 않는다.
적용 전에도 워커는 동작하며 새 시간 값은 미확인으로 표시한다. 트레이스 수집은 상태
스키마가 준비될 때까지 대기한다.

The authorized operator must run `make migrate` before activating the metadata contracts.
Origin's `make deploy` already runs migration first. Worker code ships through the existing
Lambda/Terraform packaging and `make workers` image path. Review a saved Terraform plan
before the controller applies Lambda changes. Tempo connector code ships through Terraform;
the web app ships through `make deploy`, and tool descriptions through `make agentcore`
after migration. See [the Tempo runbook](tempo-query-generation.md).

승인된 운영자가 기존 origin 절차로 마이그레이션·웹·워커·Lambda·AgentCore를 배포한다.
Terraform은 저장된 계획을 검토한 뒤 컨트롤러가 적용한다. 이 역이식 자체는 배포나
기능 플래그 변경을 수행하지 않는다.

Deploy the web/graph writer and redeploy the `inventory_read_mcp` Lambda through the existing
Terraform operator flow. `make agentcore` alone does not ship this Lambda code. The projection
migration corrects retained-row claims at read time without requiring a graph rebuild.
The inventory-reader Lambda environment also receives the configured `graph_rebuild_interval_mins`
through `GRAPH_REBUILD_INTERVAL_MINS`, matching the web reader. Apply this binding through the same
Terraform operator flow; zero retains the 15-minute freshness floor, and failure/retention checks remain.
웹/그래프 writer와 `inventory_read_mcp` Lambda도 배포한다. Lambda 코드는 기존 Terraform
운영 절차로 배포하며 `make agentcore`만으로 반영되지 않는다. projection 마이그레이션은
그래프 재구축 없이도 보존된 행의 claim을 읽을 때 바로잡는다.
inventory-reader Lambda에도 웹과 같은 `graph_rebuild_interval_mins` 값을
`GRAPH_REBUILD_INTERVAL_MINS`로 전달한다. 같은 Terraform 운영 절차로 환경 바인딩을 적용하며,
0은 기존 15분 freshness 하한을 유지하고 실패·이전 결과 보존 검사도 유지한다.

Datasource reindexing upgrades graph queries to catalog v3, preserving optional span metadata
and metric scope labels. Earlier cached queries can supply less evidence until reindexed.
스키마 재색인은 그래프 카탈로그 v3를 반영하며, 이전 캐시는 재색인 전까지 근거가 부족할 수 있다.

## Interpretation limits / 해석의 한계

Wait includes queueing and scheduling; worker lifecycle includes retries and delays, not CPU
time alone. Completion objectives cover jobs accepted in the selected window. Overdue active
jobs miss the objective; not-yet-due jobs remain pending. Missing timing and truncated samples
withhold unsupported aggregates. Retained graphs do not prove present traffic, and unqualified
messaging names do not establish a shared broker.

대기·실행 경과 시간의 경계와 표본 범위를 유지한다. 이전 그래프·누락·부분 표본을 현재
정상 상태의 근거로 사용하지 않는다. 브로커를 식별할 근거 없이 같은 큐 이름을 합치지 않는다.

FinOps recommendation disappearance does not establish realized savings. Workload cost
allocation and deployment-event correlation need additional source data. The evaluation CLI
uses synthetic cases; fixture success is not production diagnosis accuracy.

FinOps 권장 조건 해소는 실제 절감 검증이 아니다. 업무별 원가·배포 이벤트 연계는 별도
원천 데이터가 필요하며, 합성 평가 테스트 통과는 운영 진단 정확도를 입증하지 않는다.

Related decisions / 관련 결정: [ADR-005](../decisions/005-aws-mutation-autonomy-frozen.md),
[ADR-007](../decisions/007-external-data-integration-governance.md),
[ADR-009](../decisions/009-async-worker-backbone.md).

## Trace identity boundaries / 트레이스 식별 경계

- Queue ARNs join across caller accounts/regions only within the same datasource/environment.
  The same ARN can therefore have separate nodes in different datasource/environment scopes.
  `claimedAccountId` and `claimedRegion` come only from parsed destination ARN qualifiers, with constant
  `identityProvenance: telemetry_claim`; even a host-account match does not verify a claim.
  Non-ARN broker destinations and missing qualifiers have null claims. Reporter account/region and
  stored legacy/current claim fields are never fallbacks. The UI displays the values beside the disclaimer.
  Queues have no AWS-inventory bridge. The graph row's `account_id = self` is snapshot storage
  scope, not evidence of queue ownership. Apply the new projection migration before relying on
  direct SQL-reader queries; the API and AI tool also rederive claims from retained destinations.
- DB hostname matching adds a new host-configured branch: an explicit account matching
  configured `HOST_ACCOUNT_ID`, alongside the existing absent-account and `self` branches.
  Set `HOST_ACCOUNT_ID` from trusted
  deployment configuration for manual graph rebuilds, never from a span. The resulting DB link
  is a host-name correlation, not validation of arbitrary telemetry or a queue-identity rule.
- Tempo search may omit leading hex zeros or return a 64-bit trace ID. Normalize trace hex up
  to 32 digits to full 16-byte identity; span hex and base64 bytes keep their strict widths.
  Opaque nonhex legacy IDs stay exact. A full zero parent means no parent; zero trace/child IDs
  are invalid and contribute no graph identity.

큐 ARN은 같은 데이터소스·환경에서만 호출자의 계정·리전을 넘어 연결되며, 범위가 다르면
같은 ARN도 별도 노드가 된다. 계정·리전 claim은 destination ARN을 파싱해 얻은 값만 사용한다.
비-ARN 브로커 목적지와 누락된 한정자는 null이며 호출자 정보나 저장된 claim으로 폴백하지 않는다.
UI는 값과 미검증 고지를 함께 표시하고, 호스트 계정과 같아도 검증되지 않는다. 큐를 AWS 인벤토리로
연결하지 않고, 행의 `self`는 저장 범위일 뿐 소유권 증명이 아니다. 직접 SQL 조회는 새
projection 마이그레이션을 적용해야 하며 API와 AI 도구도 보존된 destination에서 claim을 재계산한다.
DB 호스트명 매칭에는 기존 계정 부재·`self` 분기에 더해 설정된 `HOST_ACCOUNT_ID`와
명시적 계정이 일치하는 새 분기를 추가한다.
수동 그래프 재구축의 `HOST_ACCOUNT_ID`는 배포 설정에서 가져오며 span에서 설정하지 않는다.
이 DB 링크는 호스트명 상관관계이고 임의 텔레메트리 검증이나 큐 식별 규칙이 아니다.
Tempo의 짧은 hex trace ID는 16바이트로 정규화하고 span/base64 너비 검증은 유지한다.
비-hex 레거시 ID는 그대로 보존하며, 전체 0 부모는 부재이고 0 trace/child는 무효이다.

## Direct Connect assessment scope / Direct Connect 평가 범위

Only `available` and `down` establish deployed connections for health, location summaries and
owned-only SLA counts. All other states, including `deleting`, `unknown`, missing and future values,
are excluded and disclosed as unassessed. A deployed-scope health pass does not certify the whole
inventory. Missing metrics, location/device evidence and failed reads retain their unknown gates;
two observed deployed sites establish a lower bound, not complete inventory coverage.
`totals.connectionsDown`, the scoped down KPI and the deployed-health checklist share this
classification. Excluded lifecycle metadata alone is not a failure. An explicit
`ConnectionState` minimum of zero on an excluded row remains visible as a separate critical
period observation in the KPI area and checklist, without asserting a current deployed failure.
The KPI discloses assessed/excluded/unknown counts; an all-excluded fleet is unassessed, not zero-down healthy.
Graph connections, location links and LAG summaries use the same affirmative evidence.
Only deployed connections with an up metric and no down evidence count as `up`; unknown and
unassessed members are labeled separately, including period-down observations on excluded members.

상태가 `available` 또는 `down`인 커넥션만 배포된 것으로 인정해 상태·위치·owned 전용 SLA를
평가한다. `deleting`·`unknown`·누락·미래 값을 포함한 다른 상태는 제외·미평가로 고지한다.
배포 범위의 정상 판정은 전체 인벤토리의 정상 증명이 아니다. 메트릭·위치·디바이스 근거 누락과
조회 실패의 미확인 판정은 유지하며, 관측된 두 배포 위치는 하한일 뿐 전체 수집을 증명하지 않는다.
`totals.connectionsDown`·범위를 명시한 다운 KPI·배포된 커넥션 상태 체크리스트는 같은
분류를 사용한다. 제외된 수명 주기 상태만으로 장애를 만들지 않는다. 제외 행의
`ConnectionState` 최솟값이 명시적으로 0이면 KPI 영역과 체크리스트에 별도의 중요 기간 관측으로
유지하되 현재 배포 장애로 단정하지 않는다. KPI는 평가·제외·미확인 수를 고지하며,
전부 제외된 인벤토리는 다운 0건 정상 대신 미평가로 표시한다.
그래프 커넥션·로케이션 링크·LAG 요약도 같은 긍정 근거를 사용한다. 배포 상태이고 up 메트릭이
있으며 다운 근거가 없는 커넥션만 `up`으로 세고, 미확인·미평가 멤버와 제외 멤버의 기간 내
다운 관측을 별도로 표시한다.

## Frozen approval contract / 동결된 승인 계약

ADR-005 deliberately leaves `awaiting_approval` unclaimable in `db.claim_running`, even after
an approval callback. The retained remediation ASL is dark substrate, not a supported execution
path. SQL tests exercise the actual predicate before/after lifecycle migration; enabling this
path or widening the predicate is outside these review fixes.

ADR-005에 따라 승인 콜백 이후에도 `awaiting_approval`은 의도적으로 claim할 수 없다.
남아 있는 remediation ASL은 비활성 코드이며 실행을 지원하는 경로가 아니다. 실제 SQL
테스트는 lifecycle 마이그레이션 전후의 거부와 원래 행 보존을 확인한다. 이 경로 활성화나
조건 확대는 이번 검토 수정의 범위가 아니다.
