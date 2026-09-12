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

Both files retain the reviewed source bytes and `-- since:` headers. Historical timestamps
are not backfilled. Before migration, workers continue operating and new timing stays unknown;
trace collection waits for its state schema.

두 파일의 원본 바이트와 릴리스 헤더를 유지한다. 과거 시간을 추정해 채우지 않는다.
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
