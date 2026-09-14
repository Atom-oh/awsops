# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Entry convention:** describe net user-visible behavior per feature, one bullet per feature per category (a cross-feature infra/schema bullet, e.g. a shared migration list, is fine as its own line). No PR numbers, CI-review-round numbers, or iteration counts — those live in git history and the PR thread. When a later fix supersedes an earlier entry for the same feature, amend that entry in place rather than appending a new one.

## [Unreleased]

**Upstream release history — v0.9.0, 2026-08-22:** this release belongs to the [published `whchoi98/awsops` v2 release](https://github.com/whchoi98/awsops/releases/tag/v0.9.0), tagged at `f22be3a08e1af902126f1a857959ec36d4e91fb3`. The source is integrated here later; local integration fixes are tracked in this `[Unreleased]` section. The date is retained from upstream.

### Added

- Deployment dependency readiness: authenticated probes verify the deployed web identity and fresh AgentCore SSM reads, then require nonce-bound evidence for curated inventory access, a known fresh CloudFront record and a bounded model call. The probe requires admin or deployment-verifiers and a process-wide cooldown. Collection summaries expose aggregate job scope and preserve missing/failed/unknown states, and disabled invocation/readiness discovery does not query an unavailable SSM path. Optional host-only inventory validates account scope, and inventory/worker images accept verified digests. Infrastructure activation and release verification remain explicit deployment steps.

- Reviewed diagnosis handoffs: preview, copy or download selected, best-effort-sanitized drafts for knowledge, communication, and specialist workflows. Transferred text carries omission/truncation notices, per-section omitted-line counts and counts of detected severity markers; these counts do not represent complete finding coverage. Collector availability is deferred to the authenticated report, and invariant coverage stays distinct from narrative findings. Transfer remains manual.

- Custom agents and skills: account-scoped slash selection, server-ordered skill attachment, and qualified tool policies. Repeated attachment preserves its order; refresh failures retain a successful save notice. Forms expose only runtime-supported settings. Instruction-only skills retain existing gateway reads under account caps; declared or revoked empty intersections deny all tools with an explicit chat notice. Curated egress/ingress registration and toggles remain available while arbitrary MCP registration stays retired. Unavailable custom routing is disclosed while built-in chat and product help remain usable.

- Add a topology diagram + resilience assessment to the Direct Connect page (modeled on aws-samples/sample-network-resilience-agent, fitted to the house React Flow conventions): an on-premises → DX location → connection/LAG → VIF → DX Gateway → TGW/VGW layered graph (dagre layout, state-colored nodes/edges — down connections and BGP-down VIFs in red, degraded LAGs and non-associated gateway links in amber/dashed, unattached VIFs dashed), node click opens the existing side detail panel, and a resilience card scoring the AWS Direct Connect SLA tier (Maximum 99.99% = 2+ connections at each of 2+ locations · High 99.9% = 2+ locations · Single 95%) with a critical/warn checklist (connection/VIF health, location redundancy, per-location dual connections, unassociated DXGWs, unattached VIFs) — built entirely from data the page already fetches, no new AWS API calls; 4-language i18n.

- Async workload observations: ownership-scoped acceptance→first worker start→terminal timing and an optional completion objective over a selected window. Wait includes queue/scheduling and worker lifecycle includes retries; missing/inverted timestamps and truncated samples withhold unsupported timing or attainment. Existing deployments remain compatible before the additive migration, with new timing reported as unknown.

- Donut charts with $ values keep cents (2 fraction digits) in the center total, legend, and tooltip — whole-dollar rounding showed real sub-dollar spend as $0 beside a nonzero slice and disagreed with the adjacent 2dp KPI tiles; capped breakdowns disclose the cap in a card subtitle AND relabel the center figure honestly (e.g. the EC2 instance-types donut says 'Top-10 sum', not total — the fleet total lives in the adjacent EC2 KPI tile).
- EKS Service Resources charts + node network rate view: the /eks/services fleet page gains v1's 'Service Resources' charts — top-15 'CPU per Service (millicores)' and 'Memory per Service (MiB)' bars computed by joining each Service's selector to its Running pods' scheduler-effective requests (max of app-container sum and init-container max, plus overhead — the same figure the node bars use) per (cluster, namespace) (request/reservation values, not live usage — stated in the caption; selectorless or zero-match services are excluded rather than charted as 0, and a cluster whose pods fetch failed is excluded by name in the caption, never silently zeroed); the node-detail ENI traffic tiles additionally show the average rate (B/s–MB/s, packets/s) under the cumulative values, computed over the newest COMPLETE hour bucket (a still-filling bucket divided by the full hour would understate the rate ~12× just past the hour; CloudWatch has no per-ENI dimension — the tiles stay honestly instance-level, both disclosed in the tooltip).
- Transit Gateway parity completion: the TGW list gains ASN/DNS columns (ASN was already synced and shows immediately; the DNS column and the detail panel's full option set — DNS/VPN ECMP/multicast/auto-accept/default association+propagation and their route-table ids — populate on the next sync after the sync-lambda redeploy, blank until then), and the attachments table gains an inline Options column (DNS/IPv6/appliance-mode) read from the per-region VPC-attachment describe — options exist only for VPC attachments (other types read '—', disclosed in the card subtitle), and a denied options describe degrades to missing options without hiding attachments or routes, disclosed per region in the card subtitle (never presented as 'not a VPC attachment'); the options describe follows pagination and EVERY incomplete-view path — a failed page (already-fetched pages are kept), a leftover page past the pagination cap, or a VPC row the response never returned (e.g. RAM-shared cross-account) — is disclosed as incomplete rather than reported as success. The web task role gains the single read-only ec2:DescribeTransitGatewayVpcAttachments action (terraform apply required), with a test pinning every TGW SDK command to its IAM grant.
- Account-scoped resource trend + derived security-count history: the daily inventory snapshot is now written per account (over the sync's trusted-account set — an unreachable account keeps its last same-day row, a reachable-but-empty account records a genuine 0), the trend API accepts the accounts scope (validated CSV; `__all__` resolves server-side to self + the enabled member accounts — never an unfiltered read, which would sum backfill 'aggregate' rows and offboarded-account history) and returns per-day PER-TYPE account coverage, and the home trend chart, delta table, 7d net change, and cost-impact estimate all follow the account selector — the guards additionally require each compared type's coverage to equal the scope that type can ever reach (host-only SDK-collected types like S3 check against the host account; everything else against the full resolved scope — the sync runs per type, so an account can be silent for one type's run only, even on both compared days), so a silent (account, type) day — or the deploy boundary, before per-account history exists — renders '—' in the KPI and delta table, hides the cost-impact panel, and draws as a line gap in the chart (with a disclosure caption) instead of a fabricated fleet change; a CSV selection narrowed by dropped ids, or the all-accounts fallback when the accounts registry is unreadable, is disclosed under the chart, and the cost-impact panel hides whenever its own fetch degraded or resolved a different scope than the chart's (per-account history accrues from this deploy; snapshots still carry no region dimension, so a narrowed region scope keeps hiding the trend-derived KPIs). The sync also historizes three derived security series — Public S3 Buckets, Open Security Groups, Unencrypted EBS — by counting the just-synced inventory with the Security page's own predicates (lockstep-guarded), shown as delta rows and as the chart's own default-hidden Security-series toggle group (appended after the top real types so they are always reachable) but excluded from the day's total to avoid double-counting; EKS/K8s counts are deliberately not historized (v2 has no batch K8s collection — EKS reads are live on-request; ECS tasks/services already trend as their own synced types).
- Inventory/datasources i18n completion: the generic inventory pages (CloudFront/DynamoDB/WAF and every other type) and the datasources hub (form, tab, card dashboard, Explore, log view) now translate their Korean UI strings into en/zh/ja — 17 unregistered literals, the dynamic card/note catalogs (card_catalog titles, datasource-render result notes), the log-view caption pattern, and the donut/chart title patterns were registered; donut titles are composed fully in Korean so one tt() pass translates them (pre-translating the sample suffix produced untranslatable mixed strings); the two English action buttons (Add datasource / Test connection) are localized. A ratchet test pins the static-literal coverage on those surfaces (dynamic strings are covered by the registered catalogs and RULES — the test is a regression guard, not a completeness proof). Column/spec labels deliberately stay English.
- Full-fleet aggregates past the 500-row cap: capped inventory pages fetch server-side GROUP BYs (state tiles, distribution donuts, state-filter and facet dropdown options, and the exact total) over the WHOLE scoped fleet — v1 ran its aggregation SQL fleet-wide, and the v2 sample-based counts were silently inaccurate above 500 resources. Coverage is per-dimension: dimensions whose values are client-derived (lambda's runtime and dynamodb's billing donuts, ecs_task cluster/cpu/memory facets, opensearch's encryption-status donut, msk's kafka-version facet) stay sample-based, and an option list with 50+ distinct values falls back to the sample — every sample-based donut now discloses itself with the '(sampled)' qualifier (previously unlabeled). Full-fleet donut 'Other' buckets are computed against the fleet total, so they sum correctly regardless of the server's bucket cap. One aggregation call replaces the previous true-total summary call; the table, Top-N bars, and highlight cards deliberately stay sample-based.
- Per-datasource connection settings: the datasource form gains a Settings section — an upstream query timeout (seconds 1–60, default 10; forwarded as the Prometheus/Mimir API timeout param capped under the connector's HTTP timeout, and as ClickHouse max_execution_time) and a ClickHouse default database (identifier-only, validated on both the web tier and the connector before any HTTP call) — persisted per instance — the ClickHouse bound is the CEILING on every path (Explore, service graph, agent/worker — callers can only tighten it; default 10s, connector HTTP timeout aligned above it) while the Prometheus/Mimir bound applies on the Explore path capped at 10s, and the database rejects system/information_schema on both validation layers; v1's result-cache TTL is deliberately not ported (the v2 query path is uncached by design) and the timeout unit changed from ms to seconds, both disclosed in the guide. ClickHouse settings of 56–60s have an effective 55s ceiling under the Lambda wall limit; the guide distinguishes stored values from effective limits. Test, Save and Explore share effective instance configuration; saved, unavailable, endpoint and authentication states remain distinct. SQL-backfilled defaults retain their connection, endpoint changes require credential re-entry, and Datadog probes verify application-key metric access.
- Unified ECS overview page (/inventory/ecs, 'ECS Overview' in the sidebar's ECS subgroup): v1's one-screen posture restored — a summary KPI band (cluster/service counts from the loaded pages ['+' at the 500 cap], task count from the shared summary, and a tasks-below-desired attention tile aggregated only over an untruncated service page — a sample never presents a fleet total), plus the clusters and services tables stacked on one screen; each table links to its full type page for search/facets/detail (the overview is a read-only glance layer), labels a >=500-row page as a sample, shows a stale-data caption under a failed sync, and reads 'not collected yet' pre-sync instead of a fabricated empty fleet.
- Dashboard on-demand sync: the header gains an admin-only 'Sync all' action that dispatches one all-types inventory sync (async batch semantics disclosed in place — a queued acknowledgement [enqueue only, not a completion guarantee; already-running types are skipped], admin-only and sync-disabled states rendered distinctly from transient failures; data lands via the normal Refresh minutes later, no optimistic mutation).
- S3 security drill-downs: the S3 page gains v1's Bucket Map by Region (block tiles colored Public=red > Versioned=green > Standard=cyan with an explicit Unknown=gray — a bucket whose policy flag is unknown stays Unknown even when versioning is known (a denied policy lookup must not paint a reassuring color), never a confident Standard; block click opens the detail panel; sample-labeled past the 500-row cap), and the bucket detail gains an 'IAM Roles with S3 Access' section (ADMIN-ONLY — non-admins see a permission note; roles whose newly synced attached AWS-managed policies match the checked set [AmazonS3*/AdministratorAccess/PowerUserAccess/ReadOnlyAccess incl. job-function paths — other policies can also grant S3, so the empty state is matched-set-framed], max 30; the last sync run's status gates every conclusion — a failed/partial run shows a stale-data banner and the empty state is only conclusive under a succeeded run within 24h on an untruncated page (a data-as-of timestamp rides the footer); a 500-row sample is labeled; inline/bucket-policy access is explicitly out of scope, and pre-sync rows show a 'not synced' note rather than an empty all-clear — visible after a terraform apply + the next sync; note: a failed policy-list hydrate — an SCP block, or a fleet whose aggregate role count exceeds the sync's rate-limit budget — triggers a hydrate-free retry so the base iam_role inventory stays live and only this section shows 'not synced' (the run reports degraded freshness so readers see the blind spot); the whole-run last-good freeze on this path requires the base query to also fail — the final run status otherwise follows the normal sync lifecycle — the ADR-010 amendment's disclosed semantics).
- Grouped cost charts: the ECS Tasks page gains v1's Cost by Service chart (CPU vs Memory daily-cost split per cluster-scoped service from the shared estimator constants — FARGATE tasks only, top 10, sample-labeled past the 500-row cap; EC2 tasks are excluded [no estimate] and serviceless tasks are excluded [nothing to group under]; both $ series share ONE scale so the CPU-vs-Memory comparison stays real), and the EKS container-cost page gains the Node Daily Cost + Pod Count chart (from the page's own OpenCost node allocation + pods list, no new fetch, cost-desc sorted; Top 15 by cost with a counted title; a cluster with ANY unattributed pod renders '—' pod values on its nodes — a shown count could undercount, so it is never a confident number under incomplete attribution) — on a new multi-series grouped-bar primitive whose per-series scaling replaces v1's dual axis for MIXED-unit series only (value labels carry the real numbers/units, and a null value renders '—' with an empty track).
- Detail drill-down quick wins: the Bedrock model detail panel gains per-model Invocations / Token time-series charts over the selected range (the API now preserves per-model series instead of discarding them into the fleet sum; an empty series reads 'no time-series data'), the ElastiCache detail chains each attached security group to its inbound rules (the RDS drill-down section/route reused — synced inventory only, no live AWS call, unsynced SGs read 'not synced'), and the EBS volume detail gains live measured metrics (Read/Write IOPS via period-sum conversion, Queue Length, Burst Balance — latest values + 1-hour sparklines on the shared live-metric contract).
- WAF/EKS quick wins: two new synced inventory types — WAF Rule Groups (scope donut, WCU capacity bar) and WAF IP Sets (IPv4/IPv6 distribution, address counts; an absent addresses field reads unknown, never 0) — joining the Security group overview's per-type count tiles (v1's three-KPI waf page maps to the group overview + dedicated type pages; visible after a terraform apply + the next sync); the EKS container-cost page's remaining hardcoded Korean strings now translate (4-language registration for the title/subtitle/estimate banner/empty states/search placeholder); and the EKS nodes fleet's Total Memory tile gains an allocatable + reserved% hint (omitted when allocatable is unreported).
- Drill-down/onboarding quick wins: the S3 bucket detail gains a Tags section (per-bucket tags newly synced — a bucket with no tags reads '—', an access-denied bucket shows nothing; visible after a terraform apply [new read-only IAM grant + sync-lambda zip] and the next sync), the EKS node drilldown's pods table gains Pod IP and Service Account columns ('-' when unknown), and the /eks page shows a no-access banner when clusters are registered but zero live K8s data is reachable — with the raw per-cluster failure reason and a locale-aware link to the docs-site EKS overview guide.
- Compliance completion email: when a benchmark run successfully completes, a best-effort SNS email goes out with the benchmark name, scope, total/passed/failed counts, pass rate, and a /compliance link — reusing the AI-diagnosis notification topic, flag, and admin pause switch (paused or unconfigured ⇒ silently skipped; a mail failure never affects the run), limited to one mail per benchmark per 60 minutes (re-runs don't re-blast subscribers), with a durable per-run delivery record (a new compliance_runs notified_at/notify_outcome migration, agent read view re-projected; recorded as a dated ADR-013 amendment).
- ECS Tasks page: a collapsible Cost Calculation Basis panel documents the Daily $/Monthly estimates — the Fargate unit-price table and formula rendered from the SAME constants the estimator computes with (the deriver now imports the shared cost-basis source), a worked example, and caveats (Fargate launch type only, ephemeral storage not priced, static prices, ×30 monthly).
- Home dashboard: a Monthly Cost Impact (est.) DIVERGING BAR chart (signed bars around a shared zero axis — increase on the warm pole, decrease on the positive pole, symmetric scaling, the 30d count delta as a muted sub-figure — shown inline on wide screens and as a visible second line on small ones (a title tooltip never surfaces on touch); a non-finite value renders '—', never a fabricated $0; the pole pair's colorblind safety was validated — CVD ΔE 13.9 light / 12.2 dark, ≥ the 8 target — and every bar carries a visible signed label) — 30-day resource-count change × a static per-type unit-cost heuristic, sorted by |impact| (top 8), explicitly labeled as a heuristic rather than billing data; fed by its own fixed 35-day account-scoped trend fetch (visible on the default view), including fully-removed types' savings, hidden when the latest snapshot is stale, when the REGION scope is narrowed (snapshots carry no region dimension; a narrowed account scope now prices that account's own deltas), or when the latest day is missing a weighted type the baseline has (a partial sync fan-out), and excluding no-baseline/no-weight types rather than showing $0.
- Chart quick wins (compliance/S3/subnets): the Compliance page gains v1's Alarms by Section bar chart (alarm counts per section from the same client rollup the pass-rate list uses; zero-alarm sections get no bar, an all-clear run omits the chart), the S3 page gains a Security Status flag-bar chart (bucket counts per Policy Private/Policy Public/Versioned/Logging flag via a new generic independent-flag spec option — the Policy bars measure bucket-policy status only, not the Security page's full exposure predicate; a bucket with no policy counts as Policy Private (both S3 inventory types now share this semantic), an unknown (access-denied) bucket counts into neither side, and until the newly synced bucket-policy public flag lands after the next sync the Policy bars are hidden rather than rendered as a fabricated 0/0), and the Subnets page gains a Subnets-per-VPC count bar.
- Security/topology quick wins: the Security page gains v1's Security Issues Summary bar chart (one bar per issue class — the four checks by finding count plus CVE Critical/High summed from the ECR scan details; zero bars are filtered and an all-zero chart is omitted) and an explicit loading line on first fetch (no more zero-valued tiles/empty charts posing as an all-clear before data arrives); the request-flow topology page gains a kind/health color legend (chips for the kinds and target-health states present in the loaded graph, theme-aware), and the infra/K8s map legend now also explains the card status dots (ok/warn/bad/neutral).
- Chart quick wins: the ElastiCache page renders v1's Node Type Distribution count bar in the chart band alongside the engine donut (a new generic count-distribution spec option), and the OpenSearch page's second donut becomes the derived Encryption Status (Full/Partial/No, semantic colors; a domain with an unknown side is excluded rather than counted as unencrypted).
- Detail/column quick wins: the IAM roles table gains a Description column, the Lambda table gains a human-readable Code Size column (the detail panel shows the readable value instead of raw bytes), the Lambda detail gains a per-layer name:version list and a Network section with an explicit 'Not in VPC' state, and the WAF detail shows the default action as Allow/Block ahead of the raw JSON.
- EKS cost page: a collapsible Cost Calculation Basis panel — the OpenCost-vs-estimate method table (5 cost items), the estimate formula rendered from the SAME unit constants the estimator computes with (single source — the documented numbers can never drift), a worked example, and the caveats (Fargate-style rates, no Spot/RI discounts, requests ≠ usage, network/PV/GPU only with OpenCost).
- Cost page quick wins: Daily Average and Last Month KPI tiles plus an 'N services increasing >20%' subtext on the Services tile; a neutral no-data banner (with an on-demand availability check; the Cost Explorer onboarding hint renders only for the host account after a confirmed 'not enabled' verdict) when the load succeeds with zero data (enable it in the Billing console — up to 24h until data appears); and the service table gains DAY-NORMALIZED threshold-colored change cells (>20% red, >0 orange, <0 green; no-baseline rows read '—' and sort last) and share mini bars with real numeric sorting — the table also picks up the shared metric-table chrome (search box, shown/total counter, problems-only toggle) and switches from mobile cards to horizontal scroll.
- Detail-panel rendering quick wins: EBS attachments flag DeleteOnTermination when set (the volume dies with the instance), the EBS detail gains an encryption verdict banner (green with the KMS key / red with the encrypted-copy recommendation; unknown shows nothing) plus a snapshot-qualified idle-volume cost hint for volumes detached at the last sync, and ECS cluster settings render as label–value rows instead of a raw JSON block.
- Inventory quick wins: the CloudFront table gains a Name column (tag-derived), the CloudTrail table gains a Last Delivery (UTC) column (the most recent SUCCESSFUL delivery — the failure signal is the detail panel's delivery error) and its detail panel gains the CloudWatch Logs role plus the CloudWatch Logs / digest delivery timestamps-and-errors and stop-logging time (visible after the next sync run), and the ECR table gains an Encryption column (the type rendered as-is: AES256/KMS/KMS_DSSE etc.).
- Topology service/network view (`/topology?view=e2e`): connect configured entry paths, saved service observations, and Network Flow Monitor traffic through scoped endpoint identities. Explicit monitor/metric/window queries expose transfer volume, RTT, retransmissions, timeouts, NAT addresses and traversed constructs; configuration, service, network, identity and context relations remain distinguishable. Search, readable flow focus and source freshness/partial-result notices support investigation without claiming a single traced request or ordered packet path. Observation integration is host/default-region scoped, account changes discard stale results, and EKS private-IP resolution uses region/VPC scope. Layer filters scope search and details, display limits prioritize observation neighborhoods, and inventory read failures stay distinct from failed/partial/running syncs while retained rows remain usable. Configuration timing uses returned-row capture ranges and per-type last-success timestamps; host run metadata is ignored outside self. Collector metadata exposes partial, stale and retained snapshots with failure reasons; absent metadata from snapshot-only producers remains neutral unknown. Existing Network Flow and service-map pages link to the view.
- AI diagnosis: an admin pause switch for the report/digest emails (one Aurora settings row — pausing needs no deploy; reports completed while a pause spans a digest run are dropped from email exactly like when no topic is configured, and a settings-read failure fails open to publishing), and a printable report view (new-tab white A4 page with a cover block, numbered anchor TOC, per-section page breaks, and Print/Close buttons) alongside the existing PDF export. A synthetic-case evaluation CLI measures evidence grounding, abstention, coverage, latency and known cost; model execution is opt-in and synthetic results are not production accuracy.
- Resource-tile micro-stat sublines (the /inventory/g category pages AND the dashboard-home tiles, rendered from one shared map so the two surfaces cannot drift): per-type state decompositions — EC2 running/stopped, Lambda runtimes (container-image functions count as 'custom') and >300s timeouts, EBS total GiB and unencrypted, RDS Multi-AZ/unencrypted, ECR scan-on-push/immutable, S3 public/versioning-off, IAM no-MFA, SG open-ingress, CloudFront enabled, VPC subnet·NAT·TGW composition, plus ECS services/tasks and WAF rule-groups/IP-sets cross-counts; the dashboard EKS tile adds a live ready-nodes/pods/deploys subline shown only when every registered cluster answered AND the account scope is all-accounts (the fleet read is unscoped — a partial or scoped read must not fabricate a confident decomposition) — all computed from the existing summary aggregation and fleet read (no new AWS calls); sublines and the health verdict are hidden, never zeroed, while loading OR when the aggregation fails.
- Compliance control detail: the slide-over now shows the control's description (the recommendation rationale) alongside Status/Reason/Resource — collected per control on new runs; rows from older runs read '—' rather than a fabricated rationale.
- EKS overview: a collapsible cluster/VPC facet filter — multi-select cluster and VPC chips (VPC chips carry their cluster counts), an active-filter badge, Clear all, and a filtered/total counter — narrowing the cluster cards and the fleet panels below.
- EKS node resources: the overview, fleet list, cluster nodes tab, and node drilldown show Allocated (Pod requests) and Usage (Metrics API CPU/memory readings) side by side against Allocatable; missing, invalid, or stale usage remains unavailable, actual zero is preserved, and disk Usage is explicitly unsupported. Per-node 3-segment capacity bars (Requested / Available / System-Reserved) for CPU and memory with 'avail X | rsv Y' captions; scheduler-requested totals come from a per-cluster pods read, and a cluster whose pods read fails shows 'requests unknown' rather than a fabricated zero; terminal (Succeeded/Failed) pods are excluded from requested totals on every surface (fleet list, overview node bars, node drill-down) to match scheduler reservations (native-sidecar init requests remain uncounted — a known follow-up), and above 40 nodes the list keeps degraded-data rows first, then the most pressured by requests or measured usage, with an explicit truncation note.
- EC2 diagnostics table: a Private IP column, and clicking a row slides in a 24-hour network panel — hourly NetworkIn/NetworkOut charts (KST axis) with Total In/Out (24h) tiles, scoped to the instance's own account and region; a missing series reads 'no data' and never fabricates a zero.
- RDS detail panel: each attached security group now chains to its inbound rules — protocol, port range, and source chips (CIDR with description, referenced SG, prefix list; open-internet sources highlighted) — resolved from the synced security-group inventory with no live AWS call; a group missing from inventory reads 'not synced' rather than claiming it has no rules.
- OpenSearch inventory sync gains eight detail columns (service software update availability, log publishing, endpoint HTTPS/TLS/custom-endpoint policy, Auto-Tune, snapshot hour, advanced options, access policies, upgrade state), surfaced as readable detail-panel fields — visible after the next sync run.
- EC2 inventory: a CPU Top 15 bar chart in the chart band ranks instances fleet-wide by their latest CloudWatch CPU (name-tag labels, instance-id fallback) — instances are queried per inventory region with batched GetMetricData, and the same batches feed the fleet-average KPI card.
- OpenSearch detail panel: the raw cluster_config/EBS/VPC/encryption JSON blobs are replaced by structured, labelled sections — Dedicated Master, Zone Awareness, Warm/Cold storage, Multi-AZ Standby, an EBS volume one-liner (type·size·IOPS·throughput), VPC/subnet/SG lists, the KMS key, and advanced-security flags as badges (the raw advanced-security/Cognito blobs stay visible for their underived fields).
- ElastiCache/OpenSearch/MSK detail sparklines + Lambda memory histogram (v1 parity): live-metric detail panels gain a 1-hour 5-minute sparkline block per spec metric (≤2 datapoints → the Avg/Max/Min fallback, a missing series reads 'no data'; one bounded read-only GetMetricData call behind the trends=1 contract, with the resource's own account AND region threaded through), and the Lambda page gains a memory-allocation histogram (function counts per memory size, top 10 numerically sorted) beside the existing Top-N bar via a new generic spec option.
- RDS instance detail time-series (v1 parity): the RDS slide-over gains three trend blocks — 1-hour 5-minute sparklines for the six v1 metrics (CPU, freeable memory, connections, read/write IOPS, free storage; a series with ≤2 datapoints renders the v1 Avg/Max/Min fallback instead of a misleading two-point line, and a missing series reads 'no data'), a 24-hour freeable-memory trend, and a 14-day daily CPU trend, each with Avg/Max/Min tiles. Two bounded, parallel read-only GetMetricData calls (a ~65-minute spark window + a 14-day trend window — Period sets resolution, not a window) behind an opt-in `trends=1` param that returns only the trends; the existing `?id=` response shape and its consumers are untouched; no IAM/Terraform changes.
- Home-dashboard trend quick wins (v1 parity): the resource-trend chart gains show/hide toggle chips grouped as Core Resources (top 5, visible by default) and Other Resources (default-hidden — the chart now DRAWS 5 lines by default where it previously drew 8; the hidden three re-enable with one click, and colors stay pinned when toggling), and an inline summary KPI bar shows tracked resource types · total resources · 7d net change (±-colored; '—' when fewer than two snapshots exist, when no snapshot lands within the delta table's ±2-calendar-day tolerance, when the only qualifying baseline IS the latest snapshot, when the REGION scope is narrowed (snapshots carry no region dimension, and one KPI row must not mix a region-scoped total with an unscoped delta; a narrowed ACCOUNT scope now shows that account's own net change), or when the two compared days snapshot different type sets — STRICT parity, since any diff over a partial sync day is a sync artifact presented as a fleet change; the adjacent delta table likewise renders '—' instead of a fabricated Current 0 / −100% for a type whose sync day is missing).
- EBS volume detail drill-downs (v1 parity): the volume slide-over now shows the attached EC2 instances as enrichment cards (Name/type/state pill from the synced inventory — an instance missing from the sync renders its id with a 'not in inventory' note, never a fabricated state) and the volume's snapshots as a sub-list (newest 20: id · size · encryption badge · date, with an explicit cap note and a 'no snapshots for this volume' empty state). Pure Aurora cross-queries over already-synced rows via one new account-scoped BFF route — no new AWS calls.
- Small v1-parity sweep: CloudTrail event rows open a detail slide-over (event id/region/source IP/user agent/access key/error code, every resource on the event, and — for ADMINS only, matching the repo's identity-data gating — a PROJECTED raw-event view + access key: the userIdentity block is reduced to selected identity attributes and credential-family keys inside request/response params are recursively masked by a normalized deny-list (defense-in-depth atop CloudTrail's own sensitive-field masking, not a completeness guarantee); same LookupEvents call, no new AWS surface); CloudWatch alarms sort worst-first by default, applied in SQL BEFORE the row cap so firing alarms always fit the page (ALARM → INSUFFICIENT_DATA → OK, newest state change first — a column-header click still overrides); the inventory 'Total N' tile, page subtitle, filter total, and risk-hero total use a true DB count once the 500-row fetch cap is hit (now supplied by the per-type aggregation endpoint — see the full-fleet aggregates entry above) — and the summary endpoint (which the home dashboard also calls) now honors the region scope it was already being sent, so region-narrowed landing-page counts/splits narrow accordingly; Lambda rows show a formatted last-modified date and render a null runtime as 'custom' (container-image functions — table, donut, facet, and detail all agree); and the Bedrock page gains a 'Models used' KPI tile (models actually invoked in the selected range; the 30d range notes its ~2-week metric-discovery window).
- AI-diagnosis generation UX quick wins (v1 parity): a running diagnosis shows an mm:ss elapsed timer and a per-section checklist grid (completed / pending, in the UI language — driven by a new additive `completed` list the worker streams into the progress JSONB; no per-section spinner on purpose, since concurrent rendering leaves no in-flight telemetry to show; older in-flight rows and a drifted section catalog fall back to the bar-only view), a completed report shows a stats bar (section count · duration · report id — duration comes from a new `finished_at` column stamped at terminal write [one additive migration]; legacy rows without it omit the segment, never fabricated), the empty state previews the full section scope with Deep-tier tags, and completed history rows carry inline MD/DOCX download links (no need to open the report).
- AI-diagnosis parity batch (v1 parity): a completed report now renders as collapsible section cards with a sticky table-of-contents sidebar (click scrolls to the section) and a per-section severity icon derived from body keywords (a display heuristic, labeled as such — not a score; reports without section headings keep the continuous view); report generation language is selectable (Korean/English/Chinese/Japanese — defaults to the UI language, applies to manual runs and schedules; the language is part of the run's dedup key, so a same-hour language switch starts a new run instead of returning the previous language's report; a legacy dedup-key read fallback ships for one release for rolling-deploy compatibility — REMOVE in the release after this one); the auto-diagnosis schedule gains KST detail settings (weekday for weekly/biweekly, day-of-month 1–28 for monthly, run hour) plus a last-run timestamp display — unset fields keep the previous interval-only behavior; and admins can send a test notification to the diagnosis mailing list from the subscribers panel (one SNS publish scoped to the existing diagnosis topic — the web task's first, admin-only `sns:Publish`; a failed send surfaces its error, never a silent success).
- Inventory KPI/chart quick-win batch (v1 parity): EC2 gains a running total-vCPU tile (per-instance `cpu_options` cores×threads — actual vCPUs, not the type default); RDS a total allocated-storage tile; Lambda long-timeout (>300s, danger) and average-memory tiles; EBS volumes an encryption-rate tile (100% → accent, <80% → danger); ECS clusters get a dedicated KPI band (ACTIVE count, running tasks, active services, container instances) instead of the generic state tiles; ECR rows gain a Scan on Push column (a missing/malformed scanning config counts as No — the API default); and the CloudWatch alarm-state donut uses fixed semantic colors (green OK / red ALARM / gray INSUFFICIENT_DATA) instead of size-ordered palette colors.
- Datasource Explore/management parity batch: curated example-query and natural-language prompt chips for all 8 connector kinds, a dedicated Loki log-stream viewer (timestamps, label badges, scrollable pane), 7d/30d time-range presets (per-kind API bound: prometheus/mimir 30d with an upstream `timeout` forwarded by their connectors — the connector change ships via `terraform apply`, so run the apply before relying on 30d; Loki capped at 7d; the 5000-point density cap stays), a result metadata bar (rows/series · execution ms · query language · shape), a dismissible "AI generated from …" banner after NL→query drafting, KPI tiles and a manual refresh button on the management tab, a "Diagnose with AI" deep link on each kind's DEFAULT datasource row (the chat tool path resolves per-kind defaults; supported kinds only) that prefills the assistant composer with a section-pinned prompt (`/assistant?q=`, review-only — never auto-sends), and proportional duration bars on Tempo/Jaeger trace results.

- Datasource detail pages gain a pre-built card dashboard: registering a datasource (and each daily index run) derives an expected card set from the cached schema — the queries each card uses are stored ahead of time (new `datasource_dashboard_cards` table + a deterministic `card_catalog` in the index worker; prometheus/mimir 13 cards covering targets, CPU, memory, disk, load, network, containers, and restarts; loki 2, tempo 2, clickhouse 2) — ready Prometheus/Mimir cards are live-validated against the exact datasource before registration, through the same instant/range tool the page will execute (a conclusive PromQL error — body-derived, never a bare HTTP 4xx — disables only that card and is revalidated on the next daily run; a transient connector failure, a failed re-introspection, or a truncated schema that cannot decide a card requirement all preserve the previous card set; the connector metric-metadata tool also gains a definitive `exists` flag and 3-second upstream deadlines) — card building runs inside the existing datasource-index job, so it is gated on `datasource_diagnosis_enabled` (default false; requires `workers_enabled`/`agentcore_enabled`/`integrations_enabled`) like the diag-signal chips — and the page executes the stored queries live on view through the existing read-only query API (stat/timeseries/table cards; unavailable cards render dimmed with what's missing; a failed card shows an inline error, never a silent zero).
- Topology infra page gains two columnar map views — a 5-column infra resource map (External | VPC | Subnet | Compute | NAT) and a per-cluster K8s map (Ingress → Service → Pod → Node; host-account, connected clusters only — the in-cluster read path is host-scoped) — rendered as a real graph (fixed-column ReactFlow with edge lines), with click cross-highlighting, search highlighting, and a color legend. Built on existing inventory/EKS reads plus the pre-existing read-only `/api/tgw` live attachment describe (host-account scope only, first 20 TGWs — degradation is surfaced in the UI); the only server-side addition is the read-only `ingresses` in-cluster kind.
- FinOps baseline-recommendations engine (ADR-020, extends ADR-012, `finops_baseline_enabled`): a daily Fargate batch evaluates a rule catalog (unattached EBS volumes against a published rate card; EC2/RDS rightsizing via Compute Optimizer) against `inventory_resources` + Compute Optimizer — no CUR/Athena cost pipeline in this repo, so amounts come only from a published rate card or Compute Optimizer's own estimate, never invented; Cost Explorer/Cost Optimization Hub/Budgets-based rules are catalogued as future work, not called by this version. The deterministic engine owns status/amount (findings are ordered by amount; there is no separate engine-owned priority field yet); an LLM adds a short Korean explanation only, discarded if it states a different dollar amount. False-positive guards (protected tags, insufficient Compute Optimizer observation window, stale inventory data) demote to `needs_review` rather than hiding a finding. A rule that fails to evaluate no longer looks like a clean run — `finops_runs.status` gains a `partial` state, surfaced by the API/card, and that rule's prior findings are left untouched rather than wiped. Findings are scoped by account/region (not just resource_id), since `inventory_resources` spans every synced account/region. Read-only — no new AWS-mutation path. `ec2_rightsizing`/`rds_rightsizing` call Compute Optimizer only in the worker's host region (a per-region endpoint); each finding's evidence carries an explicit `coverage:"host-region-only"` marker rather than presenting single-region results as account-wide. New `/cost` section (`GET /api/finops/findings`); fixes the ADR-012/terraform drift where `cost-optimization-hub:*` was documented but never granted (the FinOps MCP's Cost Optimization Hub tool has been `AccessDenied` since ADR-012). **Known doc/DB drift (not fixable here):** its three migrations' `-- since: 0.8.0` header is stale — FinOps didn't exist when `[0.8.0]` was cut on 2026-08-19 — but those migrations already merged to main and are checksum-immutable, so the header can't be corrected without breaking `make migrate` for any environment that already applied them. This entry stays in `[Unreleased]` (the truthful release state); `schema_migrations.app_version` for these three rows will read `0.8.0` regardless.
- Add an SG Rules page (`/network/security-groups/rules`, `sg_rule_activity_enabled`, default false) — this is a SEPARATE, additive pipeline from the pre-existing Usage analysis (`[0.8.0]` below); it does not replace it. Rule inventory (rule id/fingerprint/version history) is derived from configured Security Groups; per-rule daily traffic evidence (`observed_compatible`/`overlapping`/`no_observed_evidence`/`unassessable`/`not_configured`) is computed by a Fargate worker (`sg_rule_scan.py`) that resolves ENI-to-SG membership snapshots and matches them against VPC Flow Logs read through Athena — via an isolated broker Lambda (`sg_rule_athena_broker.py`, ADR-019 Role B) that is the ONLY principal allowed to `sts:AssumeRole` into a target account's `AWSopsSgRuleAthenaRole`; the broker resolves account/table config server-side from an opaque `flow_source_id` (never a caller-supplied query/account), re-validates every identifier against strict allowlists, and requires the workgroup to enforce its own `BytesScannedCutoffPerQuery`. A flow can match more than one rule; partition-projection-aware watermarking and per-day SKIPDATA/truncation coverage flags feed the same honest-degrade contract used elsewhere in this app — an incomplete or unattributable day is `unassessable`, never a confident false zero. **SG-reference resolution across a genuinely cross-account or cross-region VPC-peering/RAM-shared reference is a known, disclosed gap, not a working feature today**: this release has no peering/RAM topology data source, so a rule referencing a security group that cannot be found ANYWHERE in the current account/region's own ENI-membership snapshot resolves `unassessable` (never a confident empty match) — that data source can only be populated in a future change. Matching is **day-granular, not per-flow**: `sg_rule_inventory_versions.valid_from`/`valid_to` are *observation* timestamps (the scan run that first/last saw a fingerprint), not the actual rule-change instant, so a day within the actual gap to the previous successful scan of a version boundary is also `unassessable` rather than confidently attributed to either shape (see "Fixed" below).
- Add a Network Path Check page (`/network-paths`, top-level nav entry, `network_path_check_enabled`, default false): define a source/destination check (ENI, SG, subnet route, NACL, TGW, peering/VPN/DX boundary, Network Firewall, ALB listener/target-group health, K8s NetworkPolicy/Calico/Cilium/Istio-stub layers, DNS/L7) and run it via a Fargate worker (`network_path.py`, resolve → discover → verify → conclude) that never invents a confident verdict from missing/ambiguous data for any SINGLE layer it evaluates (`unknown`/`conditional` instead of a false `allowed`/`blocked` at that layer). **This is a per-layer guarantee, not yet a full-path one**: every layer is still primarily a source-side check, so a candidate path can still report an overall `allowed` based on less than the full bidirectional policy surface for peering/TGW/VPN/DX-fronted destinations whose own ENI isn't resolved, and for ALB/NLB-fronted targets (the target's own SG is not independently checked past `target-group`) — see `network_path.py`'s own "Known structural gap" docstring section. **`fetch_live_topology` is now real** — best-effort candidate-path discovery from CACHED Aurora topology (`topology_nodes`/`topology_edges`, `class='infra'`), no longer the `NotImplementedError` stub this bullet originally described — but a full LIVE AWS/Kubernetes re-read at run time remains deliberately unimplemented, so starting a NEW run (`POST`) in `web/app/api/network-paths/[id]/runs/route.ts` still 503s (`status: "unimplemented"`) via `networkPathLiveTopologyCapabilityGate()` (`web/lib/network-path-gate.ts`); existing check definitions and prior run history remain fully viewable. `LIVE_TOPOLOGY_IMPLEMENTED` stays `false` until that separate live re-read path exists. Calico, Route 53, and K8s Ingress→Service→EndpointSlice now have REAL evaluators (given already-fetched data); Cilium/Istio remain correctly-stubbed `unknown` (never guessed). `resolve_identities()` still reads Pod/Node/ENI identity from the saved check definition's own fields, but a `pod`/`node` source declaring a `cluster` additionally gets that identity CONFIRMED against a live, read-only K8s/EC2 read (`resolve_live_identity`) rather than trusting the definition's fields as already-verified. A rule inventory row now also surfaces its own `vpc_id`.
- Inventory sync: quota-safe collection — Steampipe plugin rate limiter (env-tunable), durable per-type freshness ledger (last_success_at, partial status, unknown_attribute_count disclosure), content-preserving partial runs, and per-type freshness in the inventory MCP tools. The curated reader also supports an exact, parameterized CloudFront identity lookup without a fleet-sized response. An opt-in host guard validates STS and registry scope, retries transient identity reads within a fixed budget, and exits nonzero after rejected scope without a restart race reviving collection. (ADR-021)
- 6 new DB migrations backing the three features above: `sg_rule_activity` (flow sources / rules / rule versions / daily activity / scan runs tables), `network_path_check` (checks / runs / step results tables), `network_path_runs_error` (adds a nullable `error` column to `network_path_runs` so a failed run has somewhere to record why), and `sg_rule_inventory_vpc_id` (adds a `vpc_id` column to the rule inventory so a rule row can surface which VPC it belongs to), `inventory_sync_freshness` (adds `run_token`/`last_success_at`/`last_success_row_count` to `inventory_sync_runs`, widens the status CHECK with 'partial', and recreates the `sql_reader.inventory_sync_runs` view — still excluding `error`/`run_token`), and `inventory_sync_unknown_attrs` (adds `unknown_attribute_count` to the table and the reader view).

### Changed

- Runtime IAM: already-enabled stacks receive scoped project SSM reads, AgentCore/Gateway calls and worker task permissions on their next Terraform apply, independently of readiness or host-only flags. Read permissions include all currently advertised AWS regions, including opt-in regions, while collection still uses enabled regions; newly launched regions require an IAM refresh. Model calls retain Claude foundation/system-profile scope and exclude arbitrary application profiles. Opt-in host-only inventory omits collector cross-account role assumption and rejects new account onboarding with HTTP 409; existing Agent MCP cross-account grants remain.

- Publish developer changelog content in English; Korean changelog views use the same complete version body. Multilingual product user guides remain available.

- Relocated the security group usage analysis page from `/inventory/security_group` to its own top-level `/network/security-groups/usage` page — the embedded `SgAnalysisSection` component's own behavior/IAM is unchanged, but the new page itself additionally carries a relationship graph, a fixed-24h hits request, and a link to the Rules page; moved out of the generic inventory-type page so it can sit alongside the new SG Rules page under one `security-groups` route group.

### Fixed

- Notion and connector readiness: saved-token verification checks fresh credentials, warm read caches expire, and unavailable credential status is distinct from unconfigured. Authentication does not establish page access or chat-gateway readiness; MCP Lambda updates ship through the normal Terraform deployment.

- Gated Slack executor: normalize action-role environment keys and reject API responses that do not acknowledge the message. Direct delivery remains off by default under owner-controlled gates and human approval governance. These source corrections do not resolve the existing archive and worker-image packaging dependencies.

- Topology IP-target attribution now requires matching region/VPC and subnet or pod evidence, and host EKS ownership is not mixed into member-account graphs. Completed pods no longer obscure the active owner of a reused IP; grouped IPv6 targets preserve unambiguous address/port notation. NFM query responses expose the original cached observation window and top-contributor limit metadata.

- Tempo query generation: preserve discovered attribute scopes and observed value types for four selected HTTP-status/service-name attributes, render legacy cached tags with valid unscoped TraceQL syntax, and check AI drafts with Grafana's TraceQL parser before returning them (one correction attempt). Disable stale-value early termination for schema discovery while retaining count/time bounds; keep virtual intrinsics separate, use scoped v2 tag-value lookups with legacy fallback, and validate generated custom attributes, literal types, and explicit HTTP-status filters; disclose per-attribute sampling limits, treat truncated legacy type evidence as unknown, and distinguish name-discovery limits from type-sampling limits. Complete empty observations refresh after a short one-minute TTL and explain historical queries through Grafana/Tempo API or intrinsic-only recent queries; incomplete empty results retry discovery and report collection failure instead of an idle window. Tempo catalog hashes exclude schema content because these catalogs depend only on successful introspection; catalog versions and generation flags still invalidate them. Admin schema GET/POST summaries expose custom-attribute counts and discovery/type limits. The richer metadata requires deploying the Tempo connector Lambda and refreshing its schema, and updated gateway tool descriptions require AgentCore provisioning; see the [Tempo query-generation runbook](docs/runbooks/tempo-query-generation.md).
- Trace service maps: scope service identities by datasource/account/region/environment/namespace/cluster and preserve asynchronous span links and identifiable broker/queue relationships. The same qualified queue ARN joins callers across accounts/regions within one datasource/environment, with claimed account/region rederived only from destination ARN qualifiers in the writer, API and SQL/AI readers, including retained rows. Non-ARN/malformed destinations and missing qualifiers have null claims, with no reporter/legacy fallback; the UI shows claim values beside the unverified-telemetry disclaimer. It never establishes AWS queue ownership or an inventory bridge. DB host matching adds an explicit-account branch matching trusted configured `HOST_ACCOUNT_ID`, alongside the existing absent-account/`self` branches. Tempo zero-trimmed/64-bit hex IDs match full OTLP bytes, and zero parents mean absent without accepting zero trace/span IDs. APIs, UI and AI reader views expose failed/partial/empty/stale collection, preserve prior graphs on collection failure, and keep traffic counts separate from confidence. The inventory-reader Lambda receives the web reader's configured `graph_rebuild_interval_mins`; zero retains the existing 15-minute freshness floor. Apply the projection migration (`make migrate`) and redeploy `inventory_read_mcp` through the Terraform operator flow; see the [rollout and identity contract](docs/runbooks/source-sync-observability.md).
- AI diagnosis evidence: missing, failed or partial observations cannot become healthy verdicts or improvements. Valid-zero/observed-violation tests exercise the normalized evaluator contract; current diagnosis collectors emit X-Ray `to_ref` without `to` and no `inventory.unencrypted` aggregate, so live edge/encryption invariants remain `unknown` until those adapters provide the required evidence. Reports persist assessment coverage and unassessed verdicts, render their counts/reasons deterministically in Intended vs Actual, and show the same scope in the UI and exports; historical reports without coverage are marked assessment unavailable. Missing incident confidence is conservative, and PDF rendering blocks external resource requests.
- FinOps rightsizing MCP: read resource-specific Compute Optimizer recommendations and savings using the actual SDK contracts; distinguish unknown savings from observed zero and withhold complete totals for missing/error/currency-incompatible evidence.
- Explore NL→PromQL generation is anchored to the datasource's FULL cached metric list, ADVISORY: an unknown name (e.g. a recording rule absent from the target, like ':node_memory_MemAvailable_bytes:sum') triggers one corrective retry that shows the model its previous answer and suggests near-miss schema names, and a surviving violation returns the draft WITH a visible warning naming the tokens (softened when the cache is truncated or stale) — never a hard error, since the tokenizer and the cache can both be wrong and the connector stays the runtime authority; the prompt additionally forbids ':'-style recording-rule names not in the schema and label-mismatched vector arithmetic. Korean requests now rank the right metrics into the prompt (a curated Korean-to-metric-term vocabulary — the Korean wording for memory utilization ranks node_memory_*/container_memory_*; before, a Korean request contributed zero ranking terms and the alphabetical head filled the prompt), the Prometheus/Mimir schema cache grows from the first 500 to 3000 metric names (kube-prometheus stacks lost whole node_*/kube_* families past the old cap — a cache that looks like an old-cap snapshot is re-introspected in the background (cooldown-bounded), and an over-size schema is stored as a bounded copy by every cache writer instead of not at all), and a recording-rule miss is corrected even on a truncated cache when every unknown name's raw core IS a cached metric (the result keeps a review note). Recorded as ADR-018 §D (live, draft-only path) with BASELINE updated in the same change.

- EKS cost request-estimate: the fallback's RAM cost was effectively $0.00 for every pod (the MiB-valued memory request was divided by 1e9 as if bytes) — memory now contributes at GiB semantics, so estimated pod costs rise accordingly.
- Live-metric displays: ElastiCache `CacheHitRate` arrives as a 0–1 ratio and now renders as a real percentage (0.92 → 92%, not 0.9%), and OpenSearch `FreeStorageSpace` — which AWS/ES reports in megabytes — no longer gets divided by 1e6 as if bytes (an ~1,000,000× understatement in the latest-value grid); OpenSearch queries also send the OWNING account's `ClientId`, so member-account domains return data instead of a silent 'no data'.
- SG Rules & Usage (`sg_rule_activity_enabled`): the Athena/Glue flow-log matching path now fails closed instead of producing a confident wrong answer, or silently refusing every scan forever. Account/region scoping resolves from the union of Glue partition keys and table columns (accepting hyphenated aliases like `account-id`); the Athena SQL partition predicate uses a properly typed `DATE '...'`/`TIMESTAMP '...'` literal for a genuinely date/timestamp-typed catalog column (a plain string literal there fails every scan with a type error), while the Glue `GetPartitions` existence check — which parses a subtly different Expression grammar — always double-quotes identifiers and uses a plain string literal instead (a typed literal there risks Glue rejecting the call outright); both sides widen to a two-day {D, D+1} window (a half-open range for a `timestamp`-typed key), since Hive delivery-time partitioning can land a day's flow in the next day's file. The `partition_projection` strategy is validated at two points: at save time, a single date key needs `type=date`+`format=yyyy-MM-dd`, a Hive `year/month/day` layout needs `type=integer` on all three (`digits=2` for month/day only, since Athena's unpadded default doesn't match this module's zero-padded query literals), and a declared `range` must be present and not a closed literal date range already confirmed expired; at scan time, the day being scanned is checked against the full `NOW±N<unit>` grammar and refused if a bound can't be confidently resolved — together closing the "validates `status: valid` yet every real scan errors or false-zeros" failure class end to end. A source whose validation predates these checks self-heals on its next run (re-validates and persists through the broker's own response shape); a re-validation that itself fails refuses the run (`awaiting_validation`) rather than scanning on stale data. `observation_lag` (the day-boundary uncertainty window) is derived from the actual gap to the last successful scan, not a fixed nominal cadence.
- Network Path Check (`network_path_check_enabled`): the per-layer "never invent a confident verdict from missing/ambiguous data" contract now holds across the real evaluators. Calico policy evaluation matches the actual Calico v3 `Rule` schema — `action` is required (a missing or unrecognized action vetoes a confident verdict rather than defaulting to Allow), ports/protocol are read from the correct `source`/`destination` EntityRule (including numeric IANA protocol values), a rule- or policy-level field this adapter doesn't model (negations, ICMP/HTTP matchers, etc.) is caught by an allowlist rather than a growing deny-list, and `order` — modeled only conservatively, since this adapter still has no cross-policy precedence model — still degrades to `unknown` whenever a matching Deny/Pass rule coexists with a matching Allow. SG/NACL/K8s NetworkPolicy peer matching also treats a malformed `peer_ip` the same as a missing one, distinguishes an unresolved `peer_sg_ids` (unknown) from a confirmed-empty `peer_sg_ids=[]` (a decidable non-match), and no longer confidently denies on an unresolvable named port or a `podSelector`/`ipBlock` peer missing identity/namespace confirmation. Route 53 resolution correctly follows CNAME/ALIAS chains (re-checking multi-record/weighted-set ambiguity at every hop, not just the entry name), detects targetless pointers and cycles, synthesizes wildcards from the true RFC 4592 closest encloser, and recognizes an NS-without-SOA zone delegation at any ancestor — including the query name itself, and even when the payload carries no SOA at all — as `unknown` rather than a confident NXDOMAIN `blocked`. Ingress→Service→EndpointSlice resolution follows Kubernetes' real precedence for host (exact > one-label wildcard) and path (`Exact` > longest `Prefix`), validates the referenced port against the Service's declared ports, and degrades to `unknown` — rather than falling back to a lower-precedence match — whenever a host-matching `ImplementationSpecific`-with-path rule's own controller-defined precedence can't be confidently determined. `eval_vpn_or_dx` treats both `aws_side_state` and `route_present` as tri-state (`None` = not fetched → `unknown`, distinct from a confirmed-down/absent value → `blocked`). Live identity resolution (`resolve_live_identity`) validates every check-definition-authored field (account id, namespace/pod/node/cluster names, region) against a safe charset and a registry-backed external-id lookup before using it in a live AWS/K8s call; the EKS access-entry registration script grants a minimal Kubernetes RBAC group instead of an AWS-managed admin-view policy, merging rather than replacing existing group membership; and the target-account CFN template (`infra/cfn/awsops-target-account-role.yaml`, ADR-011) now takes an additive, optional `WorkerTaskRoleArn` parameter so a member-account read from either worker's own task role — not only the host web task role — can be trusted, requiring an operator re-deploy of that stack to take effect (`docs/runbooks/onboard-target-account.md`).
- Direct Connect: partial AWS failures now degrade honestly instead of rendering confident wrong numbers — `/api/dx` gained `degradedRegions` / `metricsDegradedRegions` / `gatewaysDegraded` / per-gateway `associationsAvailable` / `totals.gatewaysAssociationsUnknown`; the UI shows a warning banner, `+`/`≥` lower-bound markers on affected KPI tiles, an "undetermined" (not red "unassociated") badge when the association lookup itself failed, and per-query CloudWatch `StatusCode` failures (PartialData/InternalError) now count as metric degradation. Incomplete evidence inside successful responses also withholds health/redundancy passes; observed missing device metadata fails the metadata-availability check without asserting network failure. Connection health explicitly covers deployed dedicated/hosted rows (ConnectionState supports both), allows only `available`/`down`, discloses all other states (including deleting/unknown/missing) as excluded and unassessed, withholds any whole-fleet health claim and reports missing state evidence. API down totals, the scoped KPI and the deployed-health checklist share one classification; excluded lifecycle metadata alone is not a failure, while an explicit metric-zero observation on an excluded connection stays visible with critical severity and period/current-deployment context. Graph connections, location links and LAG up counts use the same affirmative evidence, with unknown/unassessed members labeled separately. Location summaries count only identified sites across deployed owned/hosted connections, exclude every other connection state, retain proven two-site redundancy alongside unknown-site coverage, and keep owned-only SLA counts separate; unknown sites cannot raise an SLA tier.
- PR review pipeline: specialist mode requires three complete reports (Codex correctness, Kiro Opus AWS/security, Kiro Sol operations/documentation); legacy mode retains 12 model/lens reports. Each requires a unique final single-line JSON frame bound to a fresh per-cell nonce; only the validated, decoded and scrubbed report reaches the chair. Frame counting uses the expected cell nonce, so earlier other-nonce source examples remain uncredited chatter while current-nonce duplicates and trailing output fail closed. Tool strings, Markdown fences and static marker examples inside the report remain data, with no completion heuristic or legacy-marker fallback; Kiro assistant prefixes and one numeric usage footer are cosmetic. Rejected previews hide encoded frame payloads and retain bounded scrubbed diagnostics. Failed/timed-out CLI output is discarded, chair and scrubber exits are checked, and each Codex/Kiro review cell has up to two 1200s attempts with hard-kill backstops within a 90-minute workflow ceiling and a 900s chair timeout. Specialist mode adds one startup request per Kiro model under `KIRO_PREFLIGHT_TIMEOUT` (120s each). Terminal model/fallback/account-limit diagnostics stop retry; successful protocol-valid output is retained on nonterminal warnings. Codex JSONL separates file/tool output from native error events before nonce validation, so echoed diagnostic examples cannot force a provider failure. Recovered stream errors retain a completed valid report without another attempt; terminal diagnostics and failed turns still block. Codex explicitly requests `global.openai.gpt-6-astra` and Kiro GPT requests `gpt-5.6-sol`. Pod Identity preflight checks the existing provider and signed caller identity before each model phase; ambient SDK refresh remains available. Labeled session tokens are scrubbed, and offline regressions run in CI and the local full test suite. Code-first three-pass diff ordering remains. Authenticated scope selection pins trusted controls and the reviewed HEAD/base; publication rechecks scope, complete sanitized reports and their hashes. Bounded previews retain access to full report tails and require explicit semantic coverage. Oversized or omitted input stops before model calls and cannot pass. Historical replay requires a verified two-parent merge whose tree matches its HEAD.

## [0.8.0] - 2026-08-19

### Added

- Make the dashboard installable as an iPhone/iPad home-screen app (PWA): web app manifest (standalone display, root scope) + Apple meta tags (apple-touch-icon, apple-mobile-web-app-capable) + 4 generated icons (180 full-bleed apple-touch, 192/512 rounded, 512 maskable), all served without the auth cookie via new Lambda@Edge public-allowlist entries (iOS fetches manifest/icons credential-less — a 3-way lockstep test pins manifest ↔ public/ files ↔ edge allowlist). Safe-area handling for notch devices (viewport-fit=cover with top/bottom/left/right env() padding on the mobile shell, scroll-gap compensation for the grown tab bar), and the browser theme-color meta now tracks the runtime theme (cobalt/teal/dark) instead of tinting dark screens cobalt. No service worker by design: live authenticated ops data gains nothing from offline caching, and iOS install does not require one.
- Rework the Network Firewall rule-hit table for readability and interactivity: the hand-rolled table is replaced with the shared MetricTable (header-click sort on every string/number column, text search, per-element action facets, danger-rows-only toggle), clicking a row opens the rule in the standard side detail panel (SID, rule groups, tri-state hit basis and why-n/a note), and two hit-count charts are added — an action-distribution donut fed by the untruncated per-action aggregation (matches the card badges) and a top-10 rule hits bar with an explicit notice when the top-100 SID aggregation is truncated; both the donut and the "no rule hits" empty state honor `alertCoverageComplete` the same way the bar chart and joined table already do, rather than presenting a temporally-partial window as definitive. MetricTable itself gains three opt-in props reused here: multi-value facets (element-level matching so filtering 'blocked' also matches 'drop, blocked' rows), a render-stage row cap that keeps search/sort operating on the full set while preserving idle rows, and a per-row class hook (restores the idle-rule dimming).
- Add stateful rule hit counts to the Network Firewall page (the 2026-08 AWS feature, which aggregates existing Alert logs rather than exposing a new API — verified against the API reference, latest botocore, and CloudWatch): the Alert-log card now aggregates hits per SID (pre-aggregated across signature/action, with a per-region overfetch and a 100-SID join cutoff — both truncation modes surfaced honestly rather than shown as exact) over the CloudWatch Logs destination and joins them with the SIDs parsed server-side from configured stateful rule groups (sid/msg/action/noalert only — rule bodies still never leave the server), surfacing configured rules with zero matches in range (policy blind spots / shadow rules) — gated on an inference (from ALERT log-group creation time/retention, not proof) that log coverage spans the selected range, not just the current logging config, and on the rule group's own `lastModified` predating the range — separately, any in-scope policy's OR any non-STATELESS rule group's `lastModified` after the range start (or `null`, treated as unknown rather than unmodified) taints attribution for the whole account (not just the groups it currently references, since a removed/deleted/edited rule group can't be enumerated from current topology), as does any ALERT log target reached via prefix-discovery rather than a confirmed logging config (that region's topology is unverifiable, and its hits still merge globally by SID like any other region's). Both range-start comparisons anchor on the earlier of the topology and log-Insights fetches' own server timestamps rather than the browser clock, since the two are independently cached. When the `ruleHits` query fails outright, a region's log groups are chunk-split (`alertTopNPartial`), or discovery is unknown, the joined table is skipped and only the pre-existing raw top-signatures fallback is shown (pass/`noalert` rows don't appear in that fallback) — the join-cutoff and per-region-cap truncations above are a distinct, milder case that keeps the joined table, marking affected rows `?`/`≥N` instead of hiding it. Otherwise, pass rules and `noalert` rules are honestly rendered n/a since neither emits alert log entries, unknown SIDs (managed rule groups) are labeled as such, and domain-list rule groups (unparseable AWS-internal SIDs) taint attribution for the account, when policy-referenced, rather than being silently ignored. Known residual gaps, documented but not closed: a firewall switching policies mid-range, or a firewall deleted mid-range outright, escape every guard above (no per-firewall "policy attached since" timestamp, and no `lastModified` at all, exist in the API) — closing this would require correlating the already-fetched CloudTrail audit stream.
- Add security group usage analysis to the `/inventory/security_group` page (`/api/sg`): usage detection (attached via ENI `Groups` + cross-referenced as a source by other SGs → flags unused cleanup candidates, excluding the non-deletable default SG), rule source/destination identification (sg-references resolved to names, CIDRs matched to inventory VPC names, `0.0.0.0/0`·`::/0` → whole-internet, `pl-` → managed prefix-list names), and per-SG traffic **hit matching** on row click — VPC Flow Logs (CloudWatch Logs destination, default-format parse; ACCEPT rows are attributed to matching ingress rules, REJECT rows surface as peer traffic only) with an NFM fallback (top-contributors over all categories, 1h cap) that identifies traffic peers only — NFM aggregates bytes bidirectionally so hits are never attributed to rules (no false idle signals); hits degrade to unconfirmed (not a confident zero) whenever the underlying evidence is incomplete — no ENI, no query result, the Insights 200-row/50-ENI caps, ICMP type/code fields, or a peer SG outside the scanned scope — so idle-rule counts only ever reflect rules with real matching evidence; scoped to the same regions as the inventory table above (host account); KPI tiles + attached-kind donut; read-only `ec2:DescribeSecurityGroups`/`DescribeManagedPrefixLists`/`DescribeFlowLogs` IAM (applied, terraform in lockstep); 4-language i18n.
- Add a Network Firewall page (`/network-firewall`, Network group): firewall / policy / rule group inventory with per-region fan-out and `AWS/NetworkFirewall` traffic aggregation over the selected range (received / passed / dropped / rejected packets and drop rate; only the 3-dimension `(AZ, Engine, FirewallName)` metric variant is summed — the `EndpointName` variant is published in parallel and would double-count; received packets/bytes additionally sum `Engine=Stateless` only, since Stateful-forwarded traffic is a re-publication of the same packets and would double the drop-rate denominator), plus five analysis lenses — protection settings off (delete / subnet change / policy change), ALERT-logging gaps (no threat visibility; a denied describe call renders as “unknown”, distinct from “off” — observed with an SCP-style deny that hits only the task role), `aws:pass` stateless default actions (traffic bypasses the stateful engine), rule group capacity (immutable after creation, flagged at 80%+) and unassociated rule groups (cleanup candidates), and per-AZ endpoint / config-sync health; KPI tiles, type/capacity charts, a firewall-checks card, three tables with sectioned detail panels; rule bodies (`RulesSource`) are deliberately excluded from responses; read-only IAM grant of 7 explicit `network-firewall:List*`/`Describe*` actions — no wildcard (applied, terraform in lockstep); 4-language i18n. Per the owner's monitoring guide the page also covers the log and audit layers: TLS-inspection metric counters, an Alert-log Insights card (which rule/sid blocked what — top sources/destinations, CloudWatch Logs destinations only with a prefix-discovery fallback when the logging describe is denied; stateful rule hit counts covered separately above), a Flow-log Insights card (top talkers, protocol distribution), a CloudTrail change-audit card (who changed policies/rules, write events first), and a 4-language collapsible diagnosis guide (metrics / logs / complementary sources with per-goal priorities).

## [0.7.0] - 2026-08-05

### Added

- Add a Direct Connect page (`/direct-connect`, Network group): connection / VIF / DX gateway inventory with per-region fan-out (gateways are global, fetched once) and `AWS/DX` CloudWatch analysis — down detection over the selected range (`ConnectionState`/`VirtualInterfaceBgpStatus` minimums), per-VIF monitoring numbers (average/peak Bps, average Pps, peak utilization from the percent-published `VirtualInterfaceUtilization*` metrics with a peak-bps ÷ bandwidth fallback covering LAG bandwidth, and latest `BgpPrefixesAccepted`/`Advertised` counts — hosted sub-1G connections only publish VIF-level Bps), BGP route visibility via the 2026-07 `ListVirtualInterfaceRoutes` API (accepted/advertised routes with AS path, communities, installed time; 200-route cap per VIF, honest degrade where unsupported), and a location-redundancy lens that flags a single-location single point of failure (Resiliency Toolkit recommends 2+ locations); KPI tiles, VIF type/traffic charts, four tables with sectioned detail panels; BGP secrets (`authKey`, `customerRouterConfig`) are stripped and never leave the server; read-only `directconnect:Describe*`+`ListVirtualInterfaceRoutes` IAM grant (applied, terraform in lockstep); 4-language i18n.

## [0.6.0] - 2026-08-03

### Added

- Add a VPC Endpoints page (`/vpc-endpoints`, Network group): all-region endpoint inventory with three analysis lenses — unused Interface endpoints via `AWS/PrivateLinkEndpoints` BytesProcessed (idle endpoints bill hourly per ENI/AZ, shown as an est. $0.0126/h), security signals (full-access policies, private DNS off), and per-VPC S3/DynamoDB Gateway coverage gaps; KPI tiles, type/service charts, a faceted table with sectioned detail; read-only `ec2:DescribeVpcEndpoints` IAM grant; 4-language i18n.
- Add the aws-data chat route (v1 parity): route listing/count/config questions to a BFF-local handler that generates SQL with the codegen model, runs it against the live Steampipe listener (single-statement SELECT-only guard, 200-row cap), self-corrects once on error, streams the SQL preview in status frames, then streams an analysis grounded in the rows; fail-open at every step — Steampipe unreachable degrades to normal routing, double SQL failure falls back to Bedrock with an explicit no-live-data notice.
- Add auto-collect analysis chat routes (v1 parity): 6 registry-based collectors — idle-scan, eks-optimize, db-optimize, msk-optimize, trace-analyze, incident — each collects live context (Steampipe SQL, CloudWatch, CloudTrail; missing sources are marked unavailable instead of failing) and streams a grounded analysis with per-step status frames; total collection failure falls back to Bedrock with an honest notice.
- Activate the container and iac chat sections: EKS/ECS/Istio and CFN/CDK/Terraform questions now route to their gateways instead of the inactive notice (all 9 gateways have READY MCP targets).
- Add EKS fleet-node drilldown: `/eks/nodes` rows open the same rich drilldown as the overview (CPU/Memory tri-split, pods on node, ENI) via a shared `NodeDrilldownPanel` — the overview reuses it too.

### Fixed

- `opencost_config` — read-only OpenCost install config (cluster-scoped helm version/values)
- `prevention_insights` — ADR-032 Phase 4 cross-incident proactive-prevention tier
- `eks_registrations` — EKS runtime registration (in-app query onboarding; EventBridge auto-register)
- `worker_jobs.requested_by` — server-derived requester identity on every enqueue, used to scope
  `GET /api/jobs`(`/[id]`) to the caller's own jobs (2026-07-22 pentest report remediation)
- `worker_jobs` idempotency-per-requester — adds two partial unique indexes (per-requester, plus a
  NULL-requester bucket for internal enqueues) **alongside** the existing global
  `UNIQUE(idempotency_key)` (that column-level constraint is NOT dropped in this PR). This is
  Phase 1 of a two-phase rollout — dropping the old global constraint is deliberately deferred to
  a separate, later PR once this deploy is confirmed stable (round-5 review: shipping both phases
  in one PR would race `make deploy`'s migrate-then-roll-out ordering and cause a guaranteed
  enqueue outage)

### Security

- Ownership is now enforced on the diagnosis and compliance read paths too, not just jobs:
  `GET /api/diagnosis` (list), `GET /api/diagnosis/[id]`, `GET /api/diagnosis/[id]/download`, and
  `GET /api/compliance/runs` (list) + `GET /api/compliance/runs/[id]` all gate on owner-or-admin.
  Before this, any authenticated user could read or download another user's diagnosis report and
  read another user's CIS compliance run (kiro review: the security changelog omitted these)
- `POST /api/jobs` now requires auth and enforces ownership on `GET /api/jobs`(`/[id]`); the
  generic `report`/`compliance` job types were removed from its allowlist entirely — those job
  types trust client-supplied `report_id`/`run_id`/`requested_by` with no ownership check, so
  reaching them via the generic route was a cross-user IDOR write. They're only enqueueable via
  `/api/diagnosis` and `/api/compliance/run`, which compute `requestedBy` server-side
- Idempotency-key conflict lookup (`lib/jobs.ts`) is now scoped to the requesting user — a
  guessable, deterministic key (e.g. a diagnosis report key derived from the victim's email) could
  otherwise return another user's `job_id`/status and attach the attacker's payload to it
- `enqueueJob` now catches a `23505` unique_violation raised by the legacy global
  `UNIQUE(idempotency_key)` constraint above (it isn't the `ON CONFLICT` arbiter, so Postgres
  still enforces it independently) and falls back to the same requester-scoped lookup: a
  same-requester retry still dedupes cleanly, and a genuine cross-requester key collision now
  fails with a clean `409` (`IdempotencyKeyCollisionError`) instead of an opaque `500`. This
  **mitigates** the cross-user idempotency-key collision as an interim measure — full closure
  still requires the follow-up PR that drops the legacy global constraint (see the Phase 1/Phase 2
  note above; PR #195 round-6 review)
- `POST /api/jobs` now namespaces a caller-supplied `idempotency_key` as `u:<requester>:<key>`
  before it reaches the ledger. Because the legacy global `UNIQUE(idempotency_key)` is still
  enforced during Phase 1, an authenticated attacker could otherwise POST a victim's deterministic
  diagnosis key (`report:<email>:<tier>:<model>:<scope>:<hour>` — guessable from the email) to squat
  it, making the victim's own `POST /api/diagnosis` hit `23505`, fail its requester-scoped recovery
  lookup, and `409` + `markReportFailed` for that whole hour bucket. Namespacing makes squatting
  structurally impossible (a caller can only collide with their own keys) and closes the DoS
  **within this PR**, independent of the Phase 2 constraint drop. Server-minted keys (diagnosis,
  compliance) are unchanged — they already derive from the requester's own identity (PR #195
  round-7 review)
- `GET /api/compliance/runs/[id]` now uses the same dual-key (`identity()` + raw `sub`) ownership
  check as the list route and `GET /api/jobs/[id]`, instead of a direct `requested_by !==`
  comparison — a legacy sub-keyed run was visible in the list but 403'd on this detail route
  (PR #195 round-6 review)
- `/api/eks/[cluster]/register` now returns 413 (not a silent default-registration fallback) when
  the request body exceeds the size cap
- Request-body size caps (`readJsonBounded`) on several routes that previously read unbounded JSON
- Stabilize the aws-data route (4 fixes): raise the Steampipe statement timeout to 35s (cold multi-region wide scans exceeded the previous 15s) and the chat route `maxDuration` to 180s (a cold scan plus one self-correction plus a long analysis stream overran 60s); read all text blocks from the codegen response (a leading thinking block made the SQL parser return empty) and raise codegen `max_tokens` to 1024 and analysis `maxTokens` to 8192 (full listings were truncated); drop assistant turns starting with the fallback marker from codegen history (poisoned history); log SQL-generation and per-attempt failure reasons so fail-open never hides the cause.
- Stop aws-data answers claiming rows are missing and restore natural streaming: move the analysis context from a 2k-char JSON slice to compact TSV under a 24k-char budget with an explicit shown/total note, and drain SSE deltas through an adaptive typewriter buffer.
- Restore the eks-optimize collector: the curated Steampipe read policy had no EKS actions, so `aws_eks_cluster` got AccessDenied and collection returned zero rows — grant read-only `eks:Describe*`/`eks:List*` and log the per-leg collection summary on total failure.
- Resolve each Transit Gateway's region from inventory before querying: default-region clients silently returned nothing for off-region TGWs — the detail and metrics paths now fan out per-region clients with per-region degrade (partial results kept).

## [0.5.0] - 2026-08-02

First release of the **v2 line** (versioned independently from the v1 1.x line, starting at 0.5).

### Added

- **Platform — Terraform MSA, private edge & auth**
  - Rebuild the stack as a Terraform MSA (ADR-001): single `terraform/v2/foundation/` root, partial S3 backend, feature-flag gates on every large feature (default false → `plan` = No changes) — CDK dropped.
  - Serve a fully private edge path: CloudFront (TLS) → VPC Origin `https-only:443` → internal ALB HTTPS:443 (regional ACM) → Fargate `awsops-v2-web` (arm64, root path — no basePath); no public ALB.
  - Authenticate at the edge (ADR-002): Cognito User Pool + Lambda@Edge RS256 JWKS verification (iss/aud/token_use) + PKCE public client; self-hosted `/login` form (BFF `InitiateAuth` mints a 12h `awsops_token`); keep the Hosted UI PKCE flow as a dark fallback.
  - Run web as a Next.js 14 thin-BFF exposing 80 API routes — enqueue heavy work, never run it inline.
  - Add the async worker backbone (ADR-009): `POST /api/jobs` → `worker_jobs` ledger + SQS → ESM (kill-switch) → idempotent dispatcher Lambda → Step Functions `$.runtime` Choice → Lambda (short) or `ecs:runTask.sync` Fargate (long/OOM) → status_updater + 5-minute reaper.
  - Ship a Makefile deployment flow: `make configure` (interactive TUI) / `deploy` / `agentcore` / `workers` / `migrate` / `upgrade`.
- **Data — Aurora & migrations**
  - Persist all app state in Aurora Serverless v2 (PG 17.9, 0.5–4 ACU, KMS CMK, RDS-managed master secret) via node-pg — replaces v1 `data/*.json`.
  - Add the v2 DB migration framework (`make migrate`): collision-free ULID files, advisory-locked, fail-loud, version-stamped `app_version` ledger; `make migrate-status`; `scripts/v2/upgrade.sh` (`make upgrade`): RDS snapshot → migrate → idempotency check → deploy (PREVIEW unless `CONFIRM=go`). Migrations in this line include `opencost_config`, `prevention_insights`, `eks_registrations`.
  - Feed inventory through a flag-gated warm Steampipe Fargate (FDW) + sync Lambda → Aurora pipeline (`steampipe_enabled`); back-fill v1 history via `backfill-*.mjs`.
- **Inventory — 41 resource types**
  - Compute (6): EC2, Lambda, ECS Clusters, ECS Services, ECS Tasks, ECR.
  - Storage & DB (11): S3, EBS Volumes, EBS Snapshots, RDS, DynamoDB, ElastiCache, ElastiCache Replication Groups, OpenSearch, OpenSearch Serverless, MSK, Neptune.
  - Network (17): VPC, Subnet, Route Table, NAT Gateway, Internet Gateway, Transit Gateway, Security Group, Route53 Records, CloudFront, CloudFront VPC Origins, ALB, NLB, Target Group, ALB Listener Rules, API Gateway (HTTP), API GW Integrations, API GW Routes.
  - Security (6): IAM Roles, IAM Users, IAM Policies, WAF Web ACLs, CloudTrail Trails, S3 Public Access.
  - Monitoring (1): CloudWatch Alarms.
  - Give every type facet filters with live counts, a state SegmentedControl, tailored highlight KPI cards, distribution donuts + Top-N bars, and a sectioned DetailPanel; flag EOL Lambda runtimes; add CloudTrail event lookup, summary + daily-trend APIs (up to 90 days), and per-type refresh (Steampipe → Aurora sync trigger).
- **EKS suite**
  - Overview with cluster filter + node drilldown; fleet pages for nodes/pods/deployments/services (server-side live aggregation; per-cluster failures degrade to `reachable:false`).
  - K9s-style read-only in-cluster explorer with per-object describe (secrets excluded).
  - Container cost via OpenCost: saved per-cluster config, 1-day allocation (KPI + per-pod cost), install-bundle download (values.yaml + install.sh, run out-of-band), install-status badge.
  - Cluster register/unregister + Access Entry status with onboarding guidance (Terraform grants Access Entry + AmazonEKSAdminViewPolicy, read-only); control-plane + Container Insights metrics; per-instance-type ENI IPv4 limits.
- **Diagnosis tiers — 12 services**
  - Provide range-scoped CloudWatch metric tables for EC2, RDS, ElastiCache, OpenSearch, MSK (broker nodes), DynamoDB, S3, EBS, Lambda, ALB, NLB, and EKS (layered: control plane / nodes / workloads / addons).
  - Attach collapsible per-service diagnosis guides in all 4 UI languages; add a Target Group health table and TGW detail section.
- **Network tools**
  - Network Flow Monitor: live NFM top-contributor queries (pod-level endpoints, 1-hour API window), End-to-End hop-path visualization, onboarding-aware menu gating.
  - DNS query logs: Route53 Resolver + CoreDNS analysis via Logs Insights aggregation (RCODE/type/top domains/NXDOMAIN/sources/firewall; resolver comparison with honest latency gaps).
  - IP addresses: ENI-based IP→resource lookup (15+ owner kinds), unused-EIP / detached-ENI detection, EKS pod-IP join.
  - Topology: read-only graph API (flow/infra classes, `?from=` subgraphs) with infra / resource / services views; AWS-console-style VPC Resource Map.
- **AI**
  - AI assistant: hybrid routing (regex fast-path + Haiku classifier, ADR-003) across 9 chat sections (network/container/data/security/cost/monitoring/iac/ops/observability) with cross-domain auto-synthesis; SSE streaming (markdown renders while streaming); thread history with search, per-thread and delete-all; slash menu, preset chips, follow-up suggestions, session stats bar, floating 🤖 launcher; Bedrock Sonnet 5 / Opus 4.8 / Haiku 4.5.
  - AgentCore (ADR-004): 9 section gateways (8 AWS domains + external-obs) + shared Strands Runtime + Memory + Code Interpreter, provisioned idempotently via boto3 with SSM as config source of truth; control-plane status page.
  - AI comprehensive diagnosis (ADR-008): 15-section parallel Bedrock rendering (bounded concurrency, per-section timeout isolation, `partial` degrade), md/docx/pdf artifacts via S3 proxy download, Intent Engine (`architecture_intent`), report management UI.
  - AI insights: cached insight cards on the Overview dashboard + admin-gated regeneration enqueue (fail-closed when the flag is off, duplicate-job dedup).
  - K8sGPT read-only in-cluster diagnosis per cluster (GET-only Result reads, admin + cluster allowlist, `k8sgpt_enabled`-gated).
  - Agent Space customization: skills/agents catalog CRUD with routing keywords and gateway/model/language selection (admin).
- **Cost**
  - Cost overview: 1m/3m/6m/12m period filter, per-service detail, Cost Explorer availability probe (1h cache, `?force=1`).
  - Container cost: OpenCost per-pod EKS cost incl. NFM per-pod transfer cost; Fargate daily/monthly cost estimates on ECS tasks and MTD cost on ECS clusters in inventory.
  - Bedrock cost: app token spend from `ai_usage_daily` aggregates + per-model usage metrics (client fan-out for "All accounts") on the Bedrock page.
- **Security & compliance**
  - Security findings: Public S3, open security-group ingress, unencrypted EBS, IAM users without MFA — derived read-only in the BFF from `inventory_resources`, with a re-sync endpoint.
  - Container-image CVE findings from ECR image scanning (v2-native successor to v1's Trivy CVE tab).
  - CIS compliance: run Powerpipe benchmarks as async Fargate `compliance` jobs with `compliance_runs`/`compliance_results` history and a static benchmark allowlist.
- **Integrations**
  - External datasources (8 kinds): Prometheus, Mimir, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog — instance CRUD + credential storage (admin), SSRF-guarded connection test, per-kind default selection, read-only query execution, natural-language query drafting (review-only, never auto-executed), predefined diagnosis signals.
  - Integration registry under ADR-007 governance: egress connectors + ingress webhook sources, single Secrets Manager secret keyed by kind slug, schema introspection/cache.
  - Multi-account (ADR-011): account CRUD with `GetCallerIdentity` anti-spoof verification, per-account region enable/disable, STS AssumeRole read-only fan-out, account/scope selectors in the shell.
- **Operations**
  - Async job queue UI: enqueue/list jobs with per-job status lookup.
  - Per-user auto-diagnosis schedules executed by the worker `schedule_dispatcher`.
  - Diagnosis-completion email notifications via SNS with subscriber management (LIVE under ADR-007 governance).
  - Incident lifecycle (flag-gated, analysis-only per ADR-006): HMAC-signed webhook ingest with active/standby secret rotation, manual trigger, detail views, cross-incident prevention insights.
  - Actions framework (kill-switch gated): list/detail/execute split between integrations-write and mutating-actions gates, fail-closed on empty action names.
  - Operational self-healing (ADR-015, default-off): Aurora secret-rotation event → `ecs:UpdateService force-new-deployment` on the host's own web service only.
- **UI/UX**
  - 4-language UI (Korean/English/Chinese/Japanese) with a language toggle; per-language diagnosis guides.
  - 3 themes (Cobalt/Teal/Dark) with a theme toggle and theme-aware chart colors.
  - Sidebar IA: collapsible groups + 2-level subgroups + per-group overview pages with attention splits; CommandPalette; mobile bottom-tab bar and mobile nav.
  - Reusable UI kit: sortable DataTable, sectioned DetailPanel, StatCard / StatTile / Meter / StatePill / SegmentedControl, resizable panels.
  - Changelog modal + sidebar version display fed by the bilingual CHANGELOG.md.
- **Observability**
  - Monitoring hub: EC2/RDS fleet tabs + single-resource time series with range selection; CloudWatch alarm inventory page.
  - Chat/AgentCore operational telemetry: per-gateway call volume, success rate, and average latency surfaced in the UI.

### Changed

- **BREAKING:** v1 (CDK/EC2/Steampipe monolith, `/awsops` basePath) is decommissioned per ADR-016 —
  v2 serves at the root path with its own auth and data plane.

### Security

- AWS-resource mutation + autonomy frozen (ADR-005); BFF never proxies secrets; in-cluster reads are
  GET-only; auth tokens are write-only in the registration API.

## [1.9.0] - 2026-05-27

### Added

- Event-driven pre-scaling — Phase 1+2 (ADR-010) ([#13](https://github.com/whchoi98/awsops/pull/13))
  - New `/event-scaling` admin page: register events, collect historical CloudWatch metrics (ASG/RDS/MSK/EBS/ALB), Bedrock Sonnet 4.6 multi-phase warmup plan via `PLAN_JSON` marker, downloadable bash scripts per resource type (KEDA/HPA, Aurora reader, MSK partition expansion, ASG warm pool, EBS IOPS)
  - **Review-then-run**: scripts are downloaded for operator review; the dashboard never executes mutating actions
  - New API route `/api/event-scaling` (GET/POST/PUT/DELETE, admin-only)
  - New SQL query file `event-scaling.ts` with CloudWatch GetMetricData batch + resource-state queries
  - 3 new libraries: `event-scaling.ts` (data model + JSON persistence), `event-scaling-prompts.ts`, `event-scaling-scripts.ts`
- ADR-029 (Proposed): Mutating Action Framework — gate model for any future write actions (ADR-010 Phase 3 dependency)
- ADR-030 (Accepted): ECS Fargate + Aurora App State + Dual-Tier ECR
  - **Phase 1 foundation** (this release): `AwsopsDataStack` CDK stack provisioning Aurora Serverless v2 PostgreSQL 15.5 (0.5–4 ACU, writer + reader, KMS-encrypted, IAM auth, private subnets), idempotent 7-table schema (`infra-cdk/data/schema.sql`), app-side pg Pool (`src/lib/db.ts`) with DSN/discrete env var resolution, and deploy script `scripts/13-deploy-aurora.sh` (deploy / schema / status / dsn subcommands)
  - Gated behind `cdk deploy AwsopsDataStack -c enableAurora=true` — default-off, doesn't affect existing single-host deployments
  - **Phase 1 dual-write** (next release): 7 source files will gain Aurora write alongside the current `data/*.json` write; reads stay on JSON until 7-day parity gate clears
- AI code-review workflow ([#12](https://github.com/whchoi98/awsops/pull/12)) — automated PR reviews via GitHub Actions invoking Claude
- Test coverage analysis and improvement plan ([#11](https://github.com/whchoi98/awsops/pull/11)) — `docs/TEST-COVERAGE-PLAN.md` with current gaps and prioritized targets

### Fixed

- Zombie connection cleanup hardened to survive Steampipe FDW hangs — uses a dedicated short-lived `Client` (not pool) so it works even when the pool is exhausted; threshold lowered to 90s for Cost Explorer / IAM summary FDW paths
- CIS benchmark fails with `relation does not exist` in single-account mode — schema resolution fixed for non-aggregator setups
- Benchmark parameter validated against allowlist before shell invocation (prevents command injection)
- `global.anthropic.claude-sonnet-4-6` model ID used for alert diagnosis (was returning a 4xx with the regional ID)

### Infrastructure

- New CDK stack `AwsopsDataStack` (`infra-cdk/lib/awsops-data-stack.ts`) — opt-in via `enableAurora` context flag
- `infra-cdk/data/schema.sql` is source-controlled (negation rule added to `.gitignore`)
- 4 CDK stacks total: `AwsopsStack`, `AwsopsCognitoStack`, `AwsopsAgentCoreStack`, `AwsopsDataStack`

### Documentation

- ADR-029 (Proposed), ADR-030 (Accepted) — 2 new ADRs (29 → 30)
- `docs/architecture.md` — Future: ECS Fargate + Aurora Migration section, data-layer description for Aurora

## [1.8.1] - 2026-04-23

### Added

- Alert-triggered AI diagnosis pipeline (ADR-009): automatic root cause analysis from external alert sources ([#10](https://github.com/whchoi98/awsops/pull/10))
  - Webhook endpoint (`/api/alert-webhook`) for CloudWatch Alarms (SNS), Prometheus Alertmanager, Grafana Alerting, SQS, and generic webhooks
  - Alert correlation engine: groups related alerts into incidents (30s buffer, time/service/resource matching, dedup, severity escalation)
  - Investigation orchestrator: auto-selects collectors + datasource queries based on alert context, change detection (CloudTrail + K8s rollouts)
  - Bedrock Sonnet root cause analysis with structured output (timeline, remediation, prevention)
  - `AlertContext` scopes collector queries to firing alert's services/resources/namespaces (±10min window)
  - Slack notification client (Block Kit, severity-based channel routing, thread updates for webhook + bot modes, resolved state)
  - Knowledge base with monthly summary persistence (`data/alert-diagnosis/summary-YYYY-MM.json`) and past incident similarity search
  - SQS background poller, Alert Settings admin page (`/alert-settings`)
  - HMAC-SHA256 webhook authentication and rate limiting
  - Active incidents exposed via `GET /api/alert-webhook`; header badge + home card poll every 30s
- Documentation expansion:
  - 18 new ADRs (011-028) covering datasources, SNS, reports, Bedrock model, cache warmer, Cognito, SSE, HMAC, adminEmails, CDK split, multi-route, i18n, code interpreter, CloudFront
  - 5 new runbooks: alert pipeline, cache warmer, Cognito auth, deploy flow, multi-account
  - 11 new module CLAUDE.md files (docs/, runbooks/, decisions/, agent/, scripts/, tests/, infra-cdk/, ai-diagnosis/, alert-settings/, k8s/, collectors/)
  - Web guide: new `monitoring/ai-diagnosis.md` and `monitoring/alerts.md` pages (KO+EN), intro/FAQ updates
- `LICENSE` file (MIT)

### Fixed

- Report download buttons use proxy URLs instead of raw S3 presigned URLs (STS session expiry fix)
- SSRF protection for SNS SubscribeURL, admin auth for alert config, PromQL/LogQL injection prevention
- Alert correlation: bounded retry, timer cleanup, dedup map cap, rate limit hardening
- Collector dynamic import restricted to code files via `webpackInclude` magic comment (prevents CLAUDE.md from breaking build)
- `global.anthropic.claude-sonnet-4-6` model ID used for alert diagnosis
- Duplicate AI diagnosis menu item removed from sidebar
- Unused `batchTopics` variable removed; env var replacement fixed
- Dynamic `reportBucket` config restored; 30min stale timeout
- SNS→SQS queue + DLQ + SNS subscription auto-created in `setup-alert-pipeline`
- SNS email notifications strip markdown to plaintext

### Security

- `.gitignore` tracks `.env` + `.env.*`; `.env.example` allowlisted

## [1.8.0] - 2026-04-07

### Added

- External datasource integration with 7 observability platforms: Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog ([#10](https://github.com/whchoi98/awsops/pull/10))
- Datasource management page (`/datasources`) with CRUD, connection test, and auth configuration
- Datasource Explore page (`/datasources/explore`) with direct query execution and AI query generation (natural language to PromQL/LogQL/TraceQL/SQL)
- Multi-datasource AI correlation: cross-analyze external metrics with AWS resources via `datasource` route
- AI routing expanded from 10 to 11 routes (added `datasource` route for external platform queries)
- EKS Access Entry status display and kubeconfig registration ([#11](https://github.com/whchoi98/awsops/pull/11))
- EKS Service Resources tab with clickable navigation and node ENI traffic metrics
- AI comprehensive diagnosis with 15-section Bedrock Opus analysis ([#13](https://github.com/whchoi98/awsops/pull/13))
- Diagnosis report export to DOCX, Markdown, and browser Print-to-PDF
- Scheduled auto-diagnosis (weekly/biweekly/monthly) via report scheduler
- Print-friendly report page (`/ai-diagnosis/report`) with A4 page breaks
- SSRF protection with allowlist-based private network access and defense-in-depth URL validation
- Converse Stream API for multi-route synthesis with real-time SSE streaming
- Typing effect simulation for AgentCore gateway responses
- Automatic zombie PostgreSQL connection cleanup (queries running longer than 5 minutes)
- App version displayed in sidebar, auto-read from package.json

### Fixed

- Exclude Steampipe internal FDW connections (`client_addr IS NULL`) from zombie cleanup
- Remove monitoring queries from cache warmer to prevent pg pool exhaustion from slow CloudWatch FDW calls
- Add time range filters to all monitoring metric queries to prevent unbounded query execution
- Prevent AI chat bubble width jump during SSE streaming ([#8](https://github.com/whchoi98/awsops/pull/8))
- SQL injection prevention: sanitize nodeName and validate ENI IDs before SQL interpolation in EKS pages
- Add missing `involved_object_kind`, `involved_object_name`, `count` columns to warningEvents query
- Fix undefined `errorFile` variable in benchmark route
- Add missing `ClipboardCheck` icon import in Sidebar

### Security

- SSRF defense in depth: URL validation in `datasource-client.ts` protects all outbound fetch paths including AI route
- Admin-only access enforced on datasource query and AI query generation actions
- IPv6 private/link-local address detection added (`fc00::/7`, `fe80::/10`)
- Regex capture groups for safe Tempo/Jaeger trace ID URL insertion
- Remove hardcoded S3 bucket with account ID from report route, read from `config.reportBucket`

## [1.7.0] - 2026-03-24

### Added

- Multi-account support with Steampipe Aggregator pattern (`aws` = all accounts, `aws_{id}` = single account)
- Account management page (`/accounts`) with add/remove/test functionality (admin-only via `adminEmails` config)
- `AccountSelector` dropdown and `AccountBadge` component for per-account navigation
- `buildSearchPath(accountId)` for per-account query scoping and `runCostQueriesPerAccount()` for cost data merging
- `account_id` column added to all 25 SQL query files for multi-account filtering
- Cross-account IAM role setup script (`scripts/11-setup-multi-account.sh`)
- Real-time Bedrock streaming via `InvokeModelWithResponseStreamCommand` with SSE chunk events
- Background cache pre-warming (`cache-warmer.ts`) for dashboard queries on 4-minute interval
- Cache warmer status bar displayed on dashboard, monitoring, and AgentCore pages
- Configurable customer logo in sidebar (`customerLogo`, `customerName`, `customerLogoBg` in config)

### Changed

- All 35 pages integrated with `useAccountContext()` for multi-account awareness
- DataTable auto-adds Account column when multi-account data detected
- Cache key format changed to `sp:{accountId}:{sql}` for per-account cache isolation
- Config `accounts[]` array manages accounts without code changes
- Deployment scripts expanded to 11 steps (Step 11: multi-account setup)

### Fixed

- Pool exhaustion prevention with `RESET search_path` failure handling and connection destruction

### Security

- **CRITICAL**: AssumeRole audit logging with structured JSON for CloudWatch tracking
- **CRITICAL**: ExternalId required for cross-account AssumeRole (Confused Deputy prevention)
- **HIGH**: Admin endpoint rate limiting (5 req/min/user, HTTP 429)
- **HIGH**: Alias/Region input validation (64-char limit, regex pattern)
- **HIGH**: Replace `execSync` with `execFileSync` to prevent shell injection ([#6](https://github.com/whchoi98/awsops/pull/6))

## [1.6.0] - 2026-03-21

### Added

- i18n support with Korean/English language toggle (React Context + localStorage)
- 500+ translation keys in `translations/en.json` and `ko.json`
- AI responses follow language setting (English or Korean output)
- Bedrock monitoring page (`/bedrock`) with per-model usage dashboard (CloudWatch + AWSops token tracking)
- Account Total vs AWSops usage comparison charts
- Token cost display in AI chat (input/output tokens, USD cost)
- ECS container cost page (`/container-cost`) with Fargate pricing and Container Insights metrics
- EKS container cost page (`/eks-container-cost`) with OpenCost API and request-based fallback
- OpenCost installation script (`06f-setup-opencost.sh`) for Prometheus + OpenCost on EKS
- AgentCore Memory Store for conversation history persistence (365-day retention, per-user isolation)
- Conversation history toggle panel at bottom of AI Assistant page

### Changed

- Default Bedrock dashboard time range from 24 hours to 7 days
- Cross-region model IDs added to Bedrock pricing map

## [1.5.2] - 2026-03-15

### Added

- EBS page (`/ebs`) with volumes, snapshots, encryption status, EC2 attachment mapping, idle volume detection
- MSK page (`/msk`) with Kafka clusters, broker node metrics table (CPU/Memory/Network), KRaft controllers
- OpenSearch page (`/opensearch`) with domains, encryption (N2N/At-Rest), VPC config, cluster metrics
- Resource Inventory page (`/inventory`) with 18 resource count trends, multi-line chart, cost impact estimation ([#1](https://github.com/whchoi98/awsops/pull/1))
- CloudWatch metrics tables for MSK, RDS, ElastiCache, and OpenSearch (progress bars + metric values)
- Valkey engine support in ElastiCache with color-coded engine badges
- Cost Explorer MSP/Direct Payer auto-detection at install time
- Cost snapshot fallback showing last known data on query failure
- AgentCore config externalized to `data/config.json` (no hardcoded account ARNs)
- MCP tool usage inference from response keywords displayed as badges in AI chat
- AgentCore Memory with auto-save (question/summary/route/tools/response time per conversation)

### Changed

- Dashboard cards expanded with EBS, MSK, OpenSearch in Network & Storage row
- Pool max connections increased from 3 to 5, batch size from 3 to 5
- Multi-route fallback to Bedrock Direct added, timeout increased from 60s to 90s
- Sign Out moved from Header to Sidebar (next to logo)

### Fixed

- HttpOnly cookie sign-out via server-side API (`POST /api/auth`) instead of client-side deletion

## [1.4.0] - 2026-03-13

### Added

- Multi-route AI classification: 1-3 gateways called in parallel with Bedrock response synthesis
- AgentCore dashboard page (`/agentcore`) with Runtime status, 8 Gateway cards, 125 tool inventory
- AgentCore status API (`/api/agentcore`) for Runtime/Gateway state queries
- CloudFront page (`/cloudfront-cdn`) with distributions, origins, aliases, WAF, protocol settings
- WAF page (`/waf`) with Web ACL list, rules, IP sets
- ECR page (`/ecr`) with repositories, scan config, encryption, tag mutability
- Sign Out button in Header with cookie deletion and Cognito re-authentication
- S3 Bucket TreeMap visualization by region with Public/Versioned/Standard color coding
- S3 IAM Roles section showing roles with S3 access
- RDS Security Groups with inbound rules and chained resource display
- RDS CloudWatch metrics: CPU, Memory, Connections, IOPS, Storage mini-charts
- ElastiCache Security Groups and CloudWatch metrics
- Monitoring instance detail view with full-screen metrics and date range filter (1h/6h/24h/7d/30d)
- Resource Topology redesign: Infrastructure Graph/Map views + Kubernetes 4-column resource map
- VPC Resource Map with AWS Console-style 4-column layout and click highlight
- EKS node cards with CPU/Memory progress bars and ENI detail view
- Cost Explorer period filter, service filter, projected monthly cost, and MoM change

### Changed

- Dashboard layout redesigned to 18 cards (6x3) with 1:1 sidebar mapping
- CIS Compliance updated to v4.0.0 baseline
- AI Assistant header styled to match EC2/VPC pages with ONLINE badge

### Fixed

- PieChart/BarChart Steampipe bigint string to `Number()` conversion across 8 pages
- Cost query `COALESCE(unblended, blended, 0)` for accounts with null blended_cost
- Multi-route build TypeScript implicit any type errors

## [1.3.0] - 2026-03-12

### Added

- 18 dashboard StatsCards (6x3 layout) with 1:1 sidebar menu mapping and sub-metrics
- CIS Compliance pass rate display with alarm/skip/error breakdown
- Monthly Cost sub-metrics: daily average, last month comparison, MoM change
- SSE streaming in AI Assistant with real-time progress indicators
- Response time display, clipboard copy, and follow-up question suggestions in AI chat
- EC2 memory/network info via `aws_ec2_instance_type` JOIN
- Multi-filter support in EC2: text search + State + Instance Type + VPC dropdown
- K8s Overview node cards with CPU/Memory usage progress bars
- K8s node detail view with ENI cards, per-ENI traffic, and Pods table
- EKS Explorer: Status/Node filters, pagination (25/50/100/200), cluster selector
- Route Table tab in VPC with associations, routes, and target/state details
- TGW Route Tables and Attachment detail views

### Changed

- Sidebar font size increased (`text-sm` to `text-[15px]`), icon size 16px to 18px
- StatsCard auto-shrink for long values, unified `h-full` card height

### Fixed

- RDS/ElastiCache metric chart overlap resolved with direct Recharts rendering
- Monitoring EC2 detail chart sizing with dedicated Recharts components
- K8s `parseMiB` const hoisting issue resolved by moving function outside component
- AgentCore `bedrock-agentcore:*` permission and `<tool_call>` tag cleanup
- Bedrock region changed from us-east-1 to ap-northeast-2 (global.* inference)
- Cognito custom domain `SupportedIdentityProviders` and callback URL path fixes

## [1.2.0] - 2026-03-11

### Added

- Network Gateway (17 tools) split from Infra Gateway for VPC, TGW, VPN, ENI, Firewall, Reachability, Flow Logs
- Container Gateway (24 tools) split from Infra Gateway for EKS, ECS, Istio
- AI test script `scripts/test-ai-routes.py` with interactive menu, 104 questions, 9 categories, content validation
- Test guide `docs/AI_TEST_GUIDE.md` with usage, output interpretation, and troubleshooting

### Changed

- **BREAKING:** Infra Gateway (41 tools) split into Network (17) + Container (24) for 54% faster container responses
- Gateway count increased from 7 to 8, route count from 9 to 10
- Bedrock region changed to ap-northeast-2 with global.* inference profile for ~20% latency reduction
- Benchmark route Steampipe password changed from hardcoded to dynamic lookup

### Fixed

- AgentCore permission failure with missing `bedrock-agentcore:*` in IAM role
- EKS access entry `arn:aws:sts::` to `arn:aws:iam::` format conversion
- K8s PVC `capacity`/`access_modes` JSONB serialization error with `::text` casting
- AgentCore response `<tool_call>` tag exposure cleaned with regex removal
- Cognito custom domain `SupportedIdentityProviders` and callback URL path

## [1.1.0] - 2026-03-07

### Added

- 7 role-based AgentCore Gateways replacing single gateway (Network/IaC/Data/Security/Monitoring/Cost/Ops)
- 19 Lambda functions as MCP tool targets with 125 total tools
- Dynamic gateway routing via `payload.gateway` parameter in `agent.py`
- 9-route priority keyword-based routing in `route.ts`
- Role-specific system prompts for each gateway specialist
- `create_targets.py` script for automated Gateway Target creation
- All 16 Lambda source files version controlled under `agent/lambda/`

### Changed

- **BREAKING:** Single gateway (29 tools) replaced with 7 specialized gateways (125 tools) for improved tool selection accuracy
- `network-mcp` rewritten from 1 tool (693B) to 15 tools (17KB)
- `steampipe-query` upgraded from boto3 keyword fallback to real SQL via pg8000
- Legacy gateway (`awsops-gateway-g0ihtogknw`) removed

## [1.0.1] - 2026-03-07

### Added

- CDK infrastructure stack (`awsops-stack.ts`) with VPC, EC2, ALB, CloudFront
- Cognito User Pool with OAuth2 Authorization Code flow
- Lambda@Edge (Python 3.12, us-east-1) for CloudFront JWT authentication
- AgentCore Runtime with Strands agent (arm64 Docker, ECR)
- AgentCore Gateway with MCP protocol and Code Interpreter
- 4 sub-step AgentCore scripts: Runtime (6a), Gateway (6b), Tools (6c), Interpreter (6d)
- Claude Code project scaffolding with auto-sync hooks and module documentation
- Git commit-msg hook to auto-strip Co-Authored-By lines

### Fixed

- CloudFront CachePolicy TTL=0 rejection resolved with managed `CACHING_DISABLED`
- ALB Security Group rules limit with CloudFront prefix list 120+ IPs consolidated to port range
- EC2 UserData Steampipe installation running as root instead of ec2-user
- Steampipe listen mode changed from `local` to `network` for VPC Lambda access
- Gateway Target API structure corrected to `mcp.lambda` with `credentialProviderConfigurations`
- Code Interpreter naming restriction: hyphens changed to underscores
- psycopg2 Lambda incompatibility resolved by switching to pg8000

## [1.0.0] - 2026-03-07

### Added

- AWSops Dashboard with 21 pages and 5 API routes
- Next.js 14 (App Router) with Tailwind CSS dark navy theme
- Steampipe embedded PostgreSQL integration (380+ AWS tables, 60+ K8s tables)
- Recharts metrics visualization and React Flow network topology
- Powerpipe CIS v1.5~v4.0 benchmarks
- AI routing: Code Interpreter, AgentCore, Steampipe+Bedrock, Bedrock Direct
- Bedrock Claude Sonnet/Opus 4.6 integration

[Unreleased]: https://github.com/Atom-oh/awsops/compare/940772e13f33494e512c4a03935b7e4487313c8f...HEAD
[0.8.0]: https://github.com/whchoi98/awsops/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/whchoi98/awsops/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/whchoi98/awsops/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/whchoi98/awsops/releases/tag/v0.5.0
[1.8.1]: https://github.com/whchoi98/awsops/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/whchoi98/awsops/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/whchoi98/awsops/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/whchoi98/awsops/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/whchoi98/awsops/compare/v1.4.0...v1.5.2
[1.4.0]: https://github.com/whchoi98/awsops/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/whchoi98/awsops/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/whchoi98/awsops/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/whchoi98/awsops/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/whchoi98/awsops/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/whchoi98/awsops/releases/tag/v1.0.0
