# Origin observability backport

## Recorded integration scope

This records the reviewed product-content backport from `samples/dev`
`0e7579acef9e66fcc3c5976cb846cc1f6780a390` to `origin/main` baseline
`940772e13f33494e512c4a03935b7e4487313c8f`. The source contains the observability
integration and the later merged Tempo query-generation fix.
The transfer is content-only: do not merge the public repository's git ancestry.

- Keep origin CI, review scripts, deployment policy, production configuration and private docs.
- Keep the `terraform/v2/foundation/` layout and all existing migration bytes.
- Keep existing branding and links to origin decision/review documents.
- Samples deployment and DNS changes are separate operator tasks.

## Symptoms and verification

Missing observations must not look like healthy traffic, successful work or realized savings.
Service maps disclose failed, partial, empty and stale collection. Jobs disclose acceptance,
first worker start and terminal completion. Tempo drafts use scoped attributes and parser
validation; sampling limits and unavailable schema evidence remain visible.

Run from the repository root; keep Python test files in separate processes:

```bash
(cd web && npx vitest run)
(cd web && npm run build)
(cd agent/lambda && python3 -m pytest test_tempo_mcp.py -q)
(cd agent/lambda && python3 -m pytest test_inventory_read_mcp.py -q)
(cd agent/lambda && python3 -m pytest test_aws_finops_mcp.py -q)
(cd scripts/v2/workers/diagnosis && python3 -m pytest test_signal_catalog.py -q)
(cd scripts/v2/workers/diagnosis && python3 -m pytest test_signal_catalog_gen.py -q)
bash scripts/v2/merge-verify.sh
(cd scripts/v2/incident && python3 -m pytest test_rootcause_rca.py -q)
python3 -B -m unittest discover -s scripts/v2 -p test_evaluate_diagnosis.py -v
```

## Migrations and rollout

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

The authorized operator must run `make migrate` before activating the metadata contracts.
Origin's `make deploy` already runs migration first. Worker code ships through the existing
Lambda/Terraform packaging and `make workers` image path. Review a saved Terraform plan
before the controller applies Lambda changes. Tempo connector code ships through Terraform;
the web app ships through `make deploy`, and tool descriptions through `make agentcore`
after migration. See [the Tempo runbook](tempo-query-generation.md).
The content backport itself does not deploy services or change feature flags;
those are separate operator-authorized actions.

Deploy the web/graph writer and redeploy the `inventory_read_mcp` Lambda through the existing
Terraform operator flow. `make agentcore` alone does not ship this Lambda code. The projection
migration corrects retained-row claims at read time without requiring a graph rebuild.
The inventory-reader Lambda environment also receives the configured `graph_rebuild_interval_mins`
through `GRAPH_REBUILD_INTERVAL_MINS`, matching the web reader. Apply this binding through the same
Terraform operator flow; zero retains the 15-minute freshness floor, and failure/retention checks remain.

Datasource reindexing upgrades graph queries to catalog v3, preserving optional span metadata
and metric scope labels. Earlier cached queries can supply less evidence until reindexed.

## Interpretation limits

Wait includes queueing and scheduling; worker lifecycle includes retries and delays, not CPU
time alone. Completion objectives cover jobs accepted in the selected window. Overdue active
jobs miss the objective; not-yet-due jobs remain pending. Missing timing and truncated samples
withhold unsupported aggregates. Retained graphs do not prove present traffic, and unqualified
messaging names do not establish a shared broker.

FinOps recommendation disappearance does not establish realized savings. Workload cost
allocation and deployment-event correlation need additional source data. The evaluation CLI
uses synthetic cases; fixture success is not production diagnosis accuracy.

Related decisions: [ADR-005](../decisions/005-aws-mutation-autonomy-frozen.md),
[ADR-007](../decisions/007-external-data-integration-governance.md),
[ADR-009](../decisions/009-async-worker-backbone.md).

## Trace identity boundaries

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

## Direct Connect assessment scope

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

## Frozen approval contract

ADR-005 deliberately leaves `awaiting_approval` unclaimable in `db.claim_running`, even after
an approval callback. The retained remediation ASL is dark substrate, not a supported execution
path. SQL tests exercise the actual predicate before/after lifecycle migration; enabling this
path or widening the predicate is outside these review fixes.

## Trace collection rendering

When a partial graph lacks an explanation, inspect its existing collection fields:
`nodeDrops`, `edgeDrops`, `infraUnavailable`, and per-source `windowStartMs/windowEndMs`.
The panel discloses positive loss counters and unavailable inventory context, renders
source windows separately from publication/capture clocks, and does not infer retention
from losses. `retainedPrevious` alone establishes that a saved graph is being reused.
The typed collection contract also describes optional additive producer fields; unknown
runtime data remains defensively normalized. Source-detail counts include saved sources.
Verify locally with `cd web && npx vitest run components/topology/GraphCollectionStatus.test.tsx`;
the regression uses the real graph-state reader with a database boundary fixture.
