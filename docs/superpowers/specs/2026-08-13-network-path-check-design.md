# Network Path Check

**Status:** Approved (2026-08-19). This feature stays read-only (no mutation, no active probe, per
Explicit exclusions below), so it does not raise the ADR-005/ADR-007 governance question the
SG-rules sibling spec does. Both remaining conditions from the 2026-08-13 draft are now satisfied:
(1) `docs/decisions/BASELINE.md` §2 now carries a `network_path_check_enabled` register row (added
alongside `docs/decisions/019-athena-flow-log-query-classification.md`). (2) The required adapter-
safety/status-reduction review pass ran as a `/co-agent:consensus` multi-AI panel round (codex +
kiro-cli/claude-fable-5, 2026-08-19) against this document; it found 2 MAJOR gaps — an
omission-by-failure/omission-by-inapplicability conflation, and an unreachable `failed` reduction
case caused by unstated rule precedence — both fixed in the "Result semantics" section below (see the
inline 2026-08-19 review-fix notes). Owner: 오준석(Junseok Oh), who directed the panel review and
approved this Status change after reviewing the findings and fixes.

## Summary

Add a dedicated, read-only Network Path Check workflow that answers:

> Can this EKS Pod or Node reach that AWS, internet, or on-premises destination for this protocol,
> port, host, and path?

The result is not a binary packet-level guarantee. It is a deterministic checklist of the policy
layers AWSops could inspect:

- `O` (`allowed`) - inspected and allowed
- `X` (`blocked`) - inspected and blocked
- `?` (`unknown`) - not observable or not supported
- `conditional` - no known blocker, but at least one required segment remains unknown or was cut off
  by the global deadline before it ran (`not_run`, see Result semantics). A layer can also emit
  `conditional` **directly**, not just as a candidate-level reduction outcome: an adapter that can
  only assert a scoped, non-exhaustive verdict (e.g. the NACL ephemeral-port check below, which probes
  one representative port) must not report `allowed` for a claim it cannot fully back — it reports
  `conditional` itself, and that propagates through candidate reduction the same as `unknown`/`not_run`
  (2026-08-19 review fix — see Result semantics)
- `not_run` - the global deadline was reached before this layer executed; distinct from `?` (which means
  the layer ran but couldn't be evaluated) — surfaced in per-layer results but never as a standalone
  top-level status
- `failed` - an execution-level failure (e.g. identity could not be resolved) prevented meaningful
  inspection; also the per-candidate status when every required layer is `not_run`

The engine evaluates cached topology first, then live read-only AWS and Kubernetes policy data. It
never creates a Reachability Analyzer path, executes `kubectl exec`, changes a rule, or performs any
other AWS-resource mutation. When there is no `X` and every inspectable layer is `O`, AWSops may
render operator-run validation commands. It never runs those commands.

## Existing assets and gaps

### Reused

- `agent/lambda/reachability_read_mcp.py` has deterministic ENI/EC2 SG, NACL, and subnet-route
  evaluation with no Network Insights resource creation.
- `agent/lambda/datasource_diag_mcp.py` has bounded helpers for SG chains, TGW/Peering discovery, and
  Kubernetes service endpoints. Its HTTP reachability helper (`_test_http_connectivity`,
  `agent/lambda/datasource_diag_mcp.py:594`) is **not reused, at all, by this feature** — that helper
  does a raw `urlopen()` on caller-supplied URL+headers with no metadata/link-local/private-range
  denial, making it a prompt-injectable SSRF read primitive, and actually invoking it against an
  operator-supplied destination would itself be the "packet injection or active probe" this spec
  explicitly excludes (see Explicit exclusions) — reusing it is not a lesser-guarded version of this
  feature's checks, it's a different feature (an active probe) that doesn't belong here regardless of
  guarding. The DNS/L7 layer's checks in this feature are the deterministic AWS-side reads listed above
  (Route 53 resolution, ALB listener/target-group config, Ingress/Service/EndpointSlice) — never an
  actual HTTP request to the destination. If a future feature genuinely needs an active HTTP probe, it
  must mandatorily route through `agent/lambda/datasource_http.py`'s `assert_host_allowed`/`SsrfBlocked`
  (DNS-rebinding-safe IP pinning) — not `web/lib/ssrf-guard.ts`, which is BFF TypeScript and unreachable
  from a Python MCP Lambda — as a hard requirement, not an "or confirm it's unreachable" alternative.
- `topology_nodes` / `topology_edges`, `/api/graph`, and the `flow` / `infra` / `trace` graph classes
  provide cached candidate-path discovery.
- The v2 worker backbone provides `worker_jobs`, SQS, dispatcher, Step Functions, Fargate workers,
  status updater, and stale-job reaping.
- `web/lib/admin.ts`, Cognito `sub` ownership, and dedicated domain-job routes are the authorization
  model.

### Gaps

- `reachability_read_mcp.py` is same-account and does not model TGW route tables, the destination
  return route, Network Firewall, Kubernetes policy, or L7 routing.
- Current network tools return tool-specific envelopes instead of a common checklist contract.
- There is no saved check definition, run history, comparison view, or progress ledger.
- The BFF cannot perform this multi-account and multi-cluster work inline.

## Product decisions

### UI and ownership

- Add a dedicated Network menu entry and page: `/network-paths`.
- The main screen uses the approved "Path Check" layout:
  - source selector
  - destination and request selector
  - resolved path
  - layer checklist
  - validation bundle
- Checks are saved and shared with authenticated users who can access the source account.
- The creator and an AWSops administrator may edit or delete a saved definition.
- Any authorized viewer may run the check and view its history.
- Definitions are versioned by snapshotting the full request into every run. Editing a definition
  never rewrites prior results.
- Delete is a soft delete. It removes the definition from active lists and prevents new runs while
  preserving prior run evidence for audit and comparison.

### Supported endpoints

Source:

- EKS Pod
- EKS Node

Destination:

- AWS resources, including EC2, RDS, ALB, NLB, VPC endpoints, and EKS Services
- internet IPs and URLs
- on-premises IPs and URLs reached through VPN or Direct Connect

For on-premises destinations, AWSops evaluates the AWS-visible segment only. Customer routers and
firewalls are `?` unless a future governed read-only connector is added.

### Supported policy layers

The engine is adapter-based. Each adapter is independently bounded and returns the same result
contract.

1. Source identity
   - Pod IP, Node, ENI, subnet, VPC
   - Amazon VPC CNI and Security Groups for Pods
2. Kubernetes policy
   - Kubernetes NetworkPolicy
   - Calico policy
   - Cilium policy and egress gateways
   - Istio VirtualService, DestinationRule, Gateway, AuthorizationPolicy, and PeerAuthentication
3. AWS L3/L4
   - SG ingress and egress
   - NACL forward and return rules
   - source and destination subnet routes
   - VPC Peering
   - TGW attachment, association, propagation, static route, and blackhole state
   - VPN and Direct Connect AWS-side routes
   - AWS Network Firewall policy and rule groups
4. DNS and L7
   - Route 53 resolution visible to AWSops
   - ALB listener host, path, header, method, source-IP conditions, redirect, and fixed response
   - target-group binding and health
   - Kubernetes Ingress, Service, and EndpointSlice resolution

Unsupported versions, missing CRDs, private external policy, and data-access failures become `?`.
They never become `O`.

**Reused-adapter contract, not just this feature's own layers.** `reachability_read_mcp.py`'s
`check_reachability` (reused for the SG/NACL/subnet-route layer) appends a `blocking_component` and
returns `reachable:false` whenever it finds no matching route — including for TGW route tables, the
destination return route, instance-level firewalls, prefix-list contents, and DNS, none of which it
actually evaluates (its own disclaimer says so). Wrapped unchanged, that produces a **false `X`
(blocked)** verdict for exactly the cases this feature's own "Unsupported/missing/private -> `?`, never
`O`" rule is trying to prevent — the rule as stated only forbids inventing an `allowed`, but says
nothing about the adapter inventing a `blocked`.

**A prose "translate not-modeled to `?`" rule is not implementable against the function as it stands
today** — `_route_exists()` (base `reachability_read_mcp.py:135-151`) inspects only
`DestinationCidrBlock` and returns a bare boolean; it does not expose *which* condition caused the
`false` (a genuine missing-route deny vs. a TGW/prefix-list/return-route/DNS case it never evaluated).
There is no information left in its return value for a wrapper to make the `?`-vs-`X` distinction the
previous paragraph asks for. This layer's implementation must do one of:
1. **Extend `_route_exists()`/`check_reachability`** to return structured provenance — which route
   types were actually evaluated, and which of the disclaimed-but-relevant conditions (TGW attachment
   present, prefix-list reference present, destination outside local CIDR) applied to this specific
   route table — so the new adapter can map only the conditions it actually evaluated-and-denied to `X`,
   and every disclaimed condition that applied to `?`.
2. **Or write this layer's route evaluation from scratch** in the new adapter, not by wrapping
   `check_reachability` at all, if extending the shared function is out of scope for this feature.
Either way, ship one of the two — reusing `check_reachability`'s boolean output unchanged, with no
provenance, is not an option; that's exactly the false-`X` risk this paragraph exists to close.

**The same function also cannot evaluate internet/on-premises destinations at all** — `check_reachability`
(`reachability_read_mcp.py:172`) requires *both* endpoints to resolve to ENIs and fails immediately
otherwise. This feature explicitly supports internet and on-prem destinations (DNS and L7 layer,
Direct Connect/VPN routes), so the SG/NACL/subnet-route layer for those candidates needs a **one-ended,
source-side-only** adapter path (evaluate the source ENI's own SG/NACL/route table toward the
destination CIDR/prefix, without requiring a destination ENI) — not a thin wrapper around a function
built for ENI-to-ENI pairs only.

Separately, the same adapter probes the NACL return path at a single representative ephemeral port; a
verdict of `allowed` from that adapter is scoped to that probed port only, and the wrapper must not
generalize it to "the real client's ephemeral port is also allowed" without a matching check. Concretely
(2026-08-19 review fix): unless the adapter checks the *actual* ephemeral range in play, it emits layer
status `conditional`, not `allowed`, for this layer — see Result semantics below for how `conditional`
propagates through candidate reduction.

### Result semantics

Each result uses:

```json
{
  "layer": "alb-listener",
  "status": "allowed|blocked|unknown|conditional|not_run",
  "resource": "listener/app/orders/443",
  "summary": "Host matched; path condition did not match",
  "evidence": [],
  "observedAt": "2026-08-13T00:00:00Z",
  "scope": {
    "accountId": "123456789012",
    "region": "ap-northeast-2"
  }
}
```

A layer is **required** if it sits on the path between source and destination for the candidate under
evaluation — e.g. an ALB listener layer is required only for a candidate that actually routes through
that ALB; a candidate that bypasses it (a different listener, a direct ENI-to-ENI path) never marks it
required. Adapters determine which layers apply to their candidate during `discover`/`verify`; a layer
that doesn't apply to a given candidate is omitted from that candidate's step list rather than marked
`unknown`.

> **2026-08-19 review fix (co-agent panel, codex + kiro-cli/claude-fable-5):** two MAJOR gaps closed
> below. (1) **Omission-by-inapplicability vs. omission-by-failure** were indistinguishable: if an
> adapter's own `discover`/`verify` is itself cut off by the deadline or errors before it can determine
> whether a layer applies, that layer was simply *absent* from the step list — not present as
> `not_run` — so the `not_run` safeguard below never fired and "every required layer `allowed`" could
> evaluate over an under-populated, truncated set. **A layer must be omitted from the step list only on
> a positive, completed determination that it does not apply to this candidate.** If an adapter's own
> discovery of a layer's applicability is itself interrupted, that layer is NOT omitted — it materializes
> with status `not_run`. A candidate may not reduce to `allowed` unless layer discovery/verification
> completed for every adapter that could apply to it. (2) The reduction rules previously listed
> `not_run` in both the general "conditional" rule and its own "all-`not_run` -> `failed`" rule with no
> stated precedence, making the `failed` case literally unreachable if rules are read in order (an
> all-`not_run` candidate also satisfies "at least one `not_run`"). Precedence is now explicit below.

**Per-candidate status** (computed independently for each candidate path; rules apply **in the order
listed** — an earlier-listed rule that matches takes precedence over a later one):

1. every required layer `not_run` (the deadline hit before this candidate's first layer even started,
   so **zero** evidence was gathered for it) -> that candidate is `failed` — checked FIRST, before rule
   2 below, precisely because "all not_run" would otherwise also match "at least one not_run" and make
   this case unreachable.
2. any `blocked` layer on that candidate -> that candidate is `blocked`
3. no `blocked`, and at least one required layer is `unknown`, `not_run`, or itself `conditional` ->
   that candidate is `conditional` (a layer the deadline cut off before evaluation is exactly as
   informative as one that returned `unknown`; a layer that only probed a non-exhaustive
   representative case — e.g. the single-ephemeral-port NACL return-path check above — and so cannot
   assert an unscoped verdict emits `conditional` itself, and it propagates here rather than being
   silently generalized into `allowed`)
4. every required layer `allowed` -> that candidate is `allowed`

A layer's own status is never itself reduced or reinterpreted beyond rule 3 above — a layer emitting
`conditional` always makes its candidate `conditional` (never `allowed`, never dropped), same as
`unknown`/`not_run`.

**Candidate kind** — `discover` tags each candidate `resolved` or `hypothesis` and writes one
`network_path_run_candidates` row per candidate immediately (see Aurora, below); `conclude` fills in
that row's `status` and `first_blocker` once the per-candidate reduction is computed:
- `resolved`: discovery found genuine, health-check-aware redundancy where the *specific flow being
  checked* can legitimately be served by any of the listed candidates — a multi-target-group/multi-
  healthy-target ALB backend (the LB actively distributes and fails over away from unhealthy targets;
  it does not commit a given flow to one fixed target the way routing hash-selection does) or a Route 53
  health-check-based failover record. **Both ECMP and NAT Gateway are deliberately excluded from
  `resolved`, even though each involves what looks like multiple redundant paths.** ECMP (VPC route-table
  ECMP, TGW ECMP across multiple attachments) is a deterministic per-5-tuple hash: a specific flow is
  committed to exactly one of the ECMP paths for its entire lifetime, not "any of them" — if that one path
  is blocked, the flow is blocked, full stop, regardless of whether a sibling ECMP path is healthy. NAT
  Gateway is excluded for the same deterministic-commitment reason, not because it lacks redundancy
  examples elsewhere in AWS: NAT Gateways are AZ-scoped and AWS performs **no automatic cross-AZ
  failover** between them — a private-subnet route table commits to one concrete NAT Gateway ENI, and if
  that gateway is unhealthy or its return path is blocked, the flow is blocked even though a NAT Gateway
  in a sibling AZ is fine. Treating ECMP or a single committed NAT Gateway as `resolved` and reporting
  `allowed` because *some* sibling is allowed would tell an operator their flow works when the specific
  path their flow actually takes may not.
- `hypothesis`: discovery could not narrow to the single path this flow actually takes — this covers
  **ECMP** (the path is deterministically single per flow, but *we* cannot compute which hash bucket this
  flow lands in from cached topology alone), **NAT Gateway selection** (the route table commits the flow's
  source subnet to one specific NAT Gateway; if discovery cannot cheaply confirm which NAT Gateway that
  route table currently targets, the candidate is `hypothesis`, not `resolved`, even though exactly one
  NAT Gateway is genuinely in play), and ambiguous source ENI/subnet resolution or multiple matching
  route-table entries with no way to disambiguate. Forwarding itself is deterministic — exactly one path
  exists — so multiple `hypothesis` candidates always encode *our* uncertainty about which one it is,
  never redundancy in the network.

**Overall status** is reduced across candidates, not across layers directly, and the rule depends on
candidate kind:

Per-candidate `status` (persisted on `network_path_run_candidates`, see Aurora below) is one of
`allowed|blocked|conditional|failed` — `failed` per the rule above (every required layer `not_run`,
zero evidence gathered for that candidate). The reduction folds `failed` in explicitly rather than
leaving it unhandled:

- **All candidates `resolved`**, in precedence order (each rule applies only if the prior ones didn't
  match, so together they are exhaustive over every combination of per-candidate status):
  1. every candidate `allowed` -> overall `allowed` (every avenue this flow could legitimately take was
     confirmed open);
  2. every candidate `blocked` -> overall `blocked`;
  3. no `allowed` and no `conditional` present (i.e. every candidate is `blocked` and/or `failed`, and
     not all-`blocked` per rule 2) -> overall `failed` — a `blocked` verdict requires at least one
     candidate that was actually evaluated to a confirmed deny, but once a zero-evidence `failed`
     candidate is mixed in, `failed` is the honest overall for the whole set (not `blocked`, which would
     overstate confidence in a result partly built on zero-evidence candidates);
  4. every other combination -> overall `conditional`. This is the catch-all and covers two distinct
     cases: (a) a `conditional` candidate present anywhere (evidence was gathered but stayed
     inconclusive for at least one avenue), and (b) an `allowed` candidate mixed with anything short of
     all-`allowed` — health-check-aware redundancy confirms the LB/failover mechanism *can* select any
     listed target, not that it is currently selecting the allowed one over a blocked/uncertain sibling
     (an LB's health check probes a different port than the data path, or a failover record's last
     observed state predates a change, and would keep routing live traffic to a target this check found
     blocked while a sibling target reports `allowed`). Reporting `allowed` on a single healthy sibling
     would hide that live traffic may still be landing on the blocked target; `conditional` is the
     honest overall, and the response must say which candidate(s) were blocked/uncertain so an operator
     can check the LB's actual current target selection out of band.
- **All candidates `hypothesis`** (no `resolved` candidate in this run): the reduction may not report
  `allowed` merely because one hypothesis is allowed — that would hide a real blocker on whichever
  hypothesis is the flow's actual path, which is exactly the operator's question. All-hypotheses-agree
  short-circuits the ambiguity (all `allowed` -> overall `allowed`; all `blocked` -> overall `blocked`;
  all `failed` -> overall `failed`); any disagreement among hypotheses (any mix of
  `allowed`/`blocked`/`conditional`/`failed` that isn't unanimous) -> overall `conditional`, and the
  response must say *why* — that discovery could not determine which candidate is the real path, not
  merely that some layer was uncertain. A `hypothesis` set that is entirely `blocked`+`failed` (no
  `allowed`, not unanimous) still reduces to `conditional`, not `blocked` or `failed` — the disagreement
  rule takes precedence, since not knowing which candidate is real is itself the dominant source of
  uncertainty.
- **Mixed set — both `resolved` and `hypothesis` candidates present in the same run**: this case is
  never resolved by treating one candidate kind as authoritative over the other. Reduce the `resolved`
  candidates and the `hypothesis` candidates independently, each per its own rule above, producing two
  partial statuses; then combine those two partial statuses with the same unanimity logic used within
  each kind: both partials `allowed` -> overall `allowed`; both partials `blocked` -> overall `blocked`;
  either partial `failed` with neither partial `allowed`/`conditional` -> overall `failed`; every other
  combination (including one partial `allowed` and the other anything else) -> overall `conditional`.
  Concretely: a `resolved` candidate reporting `allowed` never offsets a `hypothesis` candidate reporting
  `blocked`, and a unanimous-`allowed` `hypothesis` set never offsets a `resolved` candidate reporting
  `blocked` — each kind's `allowed` verdict is evidence only about that kind's own candidates, not about
  the other kind's.
- **Global execution-level failure before any candidate was discovered** (e.g. identity could not be
  resolved) -> overall `failed` directly, bypassing per-candidate reduction entirely (there are no
  candidates to reduce over).

This is why "any blocked layer -> blocked" cannot be the overall-status rule directly: a blocked layer
on one candidate says nothing about a sibling candidate that never touches that layer. Blocking is
scoped to the candidate that contains the layer, and only propagates to the overall result once every
candidate is accounted for (and, for `hypothesis` candidates, only once every hypothesis agrees).

Within one candidate, the UI preserves layers that were not evaluated after an earlier blocker on that
same candidate and labels them `not_run`; it does not incorrectly display them as allowed or unknown.

### Validation bundle

The validation bundle appears when:

- there is no `X`
- every AWSops-inspectable layer is `O`
- any `?` layer is explicitly listed

It may contain:

- AWS Reachability Analyzer CLI or console steps
- `kubectl` or `curl` commands for an operator to run
- on-premises handoff checks

AWSops does not execute the bundle. In-app execution would violate ADR-005 and is out of scope.

## Architecture

### Thin-BFF

Dedicated routes:

- `GET/POST /api/network-paths`
- `GET/PATCH/DELETE /api/network-paths/[id]`
- `POST /api/network-paths/[id]/runs`
- `GET /api/network-path-runs/[runId]`

The run route validates ownership, snapshots the definition, creates the run row, and enqueues the
domain job. The generic `POST /api/jobs` rejects `network_path`.

Large-feature gate:

- Terraform variable: `network_path_check_enabled`
- default: `false`
- route, enqueue, dispatcher branch, worker environment, IAM widening, and scheduled resources all
  fail closed while disabled

### Aurora

New ULID migration:

```sql
CREATE TABLE network_path_checks (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  source_account_id  text NOT NULL,
  definition         jsonb NOT NULL,
  created_by_sub     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE network_path_runs (
  id                  text PRIMARY KEY,
  check_id             text NOT NULL REFERENCES network_path_checks(id),
  requested_by_sub     text NOT NULL,
  definition_snapshot  jsonb NOT NULL,
  status               text NOT NULL,
  phase                text NOT NULL,
  overall_status       text,
  validation_bundle    jsonb,
  worker_job_id         text UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz
);

-- Review (round 7 self-check): candidate_kind (resolved|hypothesis, see Result semantics above) and
-- each candidate's per-candidate status were defined but had nowhere to be persisted — rather than
-- duplicating candidate_kind across every step row, a separate per-candidate table is the correct
-- normalization. per-candidate status is also not recomputed from steps every time; `conclude` records
-- it here once.
CREATE TABLE network_path_run_candidates (
  run_id          text NOT NULL REFERENCES network_path_runs(id) ON DELETE CASCADE,
  candidate_id    text NOT NULL,
  candidate_kind  text NOT NULL,  -- 'resolved' | 'hypothesis' — set by discover, immutable afterward
  status          text,           -- this candidate's per-candidate status; NULL until conclude runs
                                    -- ('allowed' | 'blocked' | 'conditional' | 'failed', see Result semantics)
  first_blocker   text,           -- display: this candidate's first blocker layer/summary, if any
  PRIMARY KEY (run_id, candidate_id)
);

CREATE TABLE network_path_run_steps (
  run_id        text NOT NULL REFERENCES network_path_runs(id) ON DELETE CASCADE,
  candidate_id  text NOT NULL,
  -- Review MAJOR: each result in Result semantics promises a scope{accountId,region} (required, since
  -- this is an explicitly multi-account/multi-region worker), but this table had neither column — if a
  -- candidate crosses account/region boundaries, evidence alone can't tell which account/region it was
  -- observed in.
  account_id    text NOT NULL,
  region        text NOT NULL,
  ordinal       integer NOT NULL,
  layer         text NOT NULL,
  status        text NOT NULL,
  resource      text,
  summary       text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '[]',
  observed_at   timestamptz,
  PRIMARY KEY (run_id, candidate_id, ordinal)
);
```

`candidate_id` discriminates the multiple candidate paths a run can carry — assigned by the `discover`
phase when it enumerates candidates (e.g. `c0`, `c1`, ...), stable for the lifetime of the run. Every
step row belongs to exactly one candidate; per-candidate and overall status (above) are both computed
by grouping this table on `candidate_id`.

Evidence is bounded and redacted before persistence. Raw AWS responses, credentials, Kubernetes
Secrets, labels unrelated to path evaluation, and free-form workload annotations are not stored.
`DELETE /api/network-paths/[id]` sets `deleted_at`; it does not delete runs or step evidence.

### Worker

Add internal-only `network_path` job handling:

1. `resolve`
   - resolve Pod/Node and destination identities
   - identify accounts, regions, VPCs, subnets, and ENIs
2. `discover`
   - query cached topology for candidate paths
   - keep multiple candidates until live policy evaluation eliminates them
3. `verify`
   - execute independent live read-only adapters with per-adapter deadlines
   - update `network_path_run_steps` after every terminal adapter result
4. `conclude`
   - calculate overall result
   - render the optional validation bundle
   - mark the run succeeded

The Fargate worker is preferred over inline BFF or a short Lambda because Kubernetes policy and
multi-account route analysis can exceed a single short invocation budget. The worker Dockerfile
keeps `CMD`, not exec-form `ENTRYPOINT`.

### Candidate cache and live evidence

- Aurora topology is a candidate-path accelerator, not final authority.
- SG, NACL, routes, TGW, VPN, DX, Network Firewall, ELBv2, and Kubernetes policy are re-read for the
  candidate path at run time.
- Account and region are explicit on every AWS client.
- Host-account targets use the execution role and do not self-assume `AWSopsReadOnlyRole`.
- Target accounts use the existing cross-account role and fail closed if a required read action is
  not granted.

### AI boundary

AI never assigns `O`, `X`, or `?`.

An optional final explanation may summarize the deterministic checklist and recommend the next
manual investigation. The stored checklist remains the source of truth.

## Error handling

- One adapter failure -> that layer is `?`; unrelated layers continue.
- Global deadline -> remaining layers on every still-running candidate become `not_run`; each affected
  candidate's status is computed from whatever it evaluated before the deadline (per the per-candidate
  rules above — a candidate whose required layers are entirely `not_run` becomes `failed`, one with a
  mix becomes `conditional`), and the overall status still follows the candidate-kind reduction above —
  a `resolved`-kind candidate truncated to anything short of `allowed` makes the overall result
  `conditional` even if a sibling `resolved` candidate reached `allowed` before the deadline (the
  reduction now requires every resolved candidate confirmed `allowed`, so one truncated sibling is
  itself a disagreement, not a redundancy win); a `hypothesis`-kind candidate that reached `allowed`
  does **not** by itself make the overall result `allowed` if a sibling hypothesis was truncated to
  `conditional`/`failed` by the deadline — that's still "we don't know which path is real, and couldn't
  finish checking one of them," which is `conditional`, not `allowed`.
- Identity cannot be resolved -> run completes `failed` with a bounded, non-sensitive error.
- Stale run -> a dedicated reaper query added to `scripts/v2/workers/reaper.py` reconciles
  `network_path_runs` the same way it already does for `worker_jobs`/`diagnosis_reports` — the existing
  reaper does not cover this table today and must be extended as part of this feature's implementation,
  not assumed to already apply.
- Candidate topology is stale or empty -> live discovery continues where possible and records the
  cache limitation.
- Multiple plausible paths -> compute each candidate's status independently, show each candidate with
  its first known blocker (if any), tag each `resolved` or `hypothesis`, and reduce to overall status
  per the candidate-kind reduction rule above (a `resolved` set only reduces to overall `allowed` when
  every resolved candidate is confirmed `allowed` — one blocked sibling pulls the overall result down to
  `conditional`, not `allowed`; a `hypothesis` set follows the same unanimity requirement for the same
  reason: not knowing which candidate is the real path is itself the dominant uncertainty).
- Discovery produces a mix of `resolved` and `hypothesis` candidates for the same run -> reduce `resolved`
  and `hypothesis` candidates independently per their own rules above, then combine the two partial
  results with the same unanimity logic: both partial results `allowed` -> overall `allowed`; either
  partial result anything other than `allowed` -> overall `conditional` (unless either side is `failed`
  with no `allowed`/`conditional` anywhere in the set, which reduces to overall `failed`, or every
  candidate on both sides is `blocked`, which reduces to overall `blocked`). Mixed-kind sets are never
  reduced by treating one kind as authoritative over the other — a `hypothesis` candidate reporting
  `allowed` does not offset a `resolved` candidate reporting `blocked`, and vice versa, since neither
  kind's `allowed` status is evidence about the other kind's candidates.
- On-premises segment -> always `?` past the AWS boundary.
- Unsupported Calico, Cilium, or Istio CRD version -> `?`, never an assumed allow.

## Testing

### Pure adapters

Table-driven tests cover:

- SG references, CIDRs, protocol numbers, port ranges, and multi-SG union
- NACL first-match and ephemeral return paths
- longest-prefix route selection and blackholes
- TGW association, propagation, and asymmetric return routes
- Peering, VPN, and DX boundary classification
- Network Firewall allow, drop, reject, and uninspectable rule forms
- ALB first-match listener behavior and fixed-response blockers
- Kubernetes NetworkPolicy default deny and selector matching
- Calico, Cilium, and Istio supported and unsupported schemas

### Orchestration

- adapter failure isolation
- global deadline behavior, including a truncated `resolved` sibling downgrading an already-`allowed`
  `resolved` candidate's contribution to `conditional` overall (unanimity required), while a truncated
  `hypothesis` sibling has the same downgrading effect for the same reason (disagreement, not redundancy)
- multiple candidate paths, each with independent per-candidate status
- deterministic overall-status reduction: all-`resolved` with one blocked + one allowed -> overall
  `conditional` (not `allowed` — disagreement among resolved candidates); all-`resolved` all blocked ->
  overall `blocked`; all-`resolved` no allowed, at least one conditional -> overall `conditional`
- mixed `resolved`+`hypothesis` candidate set: a `resolved` candidate `allowed` alongside a `hypothesis`
  candidate `blocked` -> overall `conditional`, not `allowed` (one kind's `allowed` never offsets the
  other kind's non-`allowed`); both kinds fully `allowed` -> overall `allowed`; both kinds fully
  `blocked` -> overall `blocked`
- a layer irrelevant to a given candidate is omitted from that candidate rather than marked `unknown`
- `network_path_run_steps` rows for two candidates at the same `ordinal` do not collide (candidate_id
  discriminates the primary key)
- evidence redaction and size caps
- definition snapshot immutability
- `_test_http_connectivity` is never called by any code path this feature adds — grep-verifiable, not
  just guard-verifiable (this feature does no active HTTP probing at all, per Explicit exclusions)
- stale-run reaping

### Web and authorization

- unauthenticated access rejected
- viewer may run and read
- only creator or admin may edit/delete
- generic `/api/jobs` rejects `network_path`
- gate-off routes fail closed
- progress polling, blocked, conditional, unknown, and failed UI states
- validation bundle shown only under the approved condition

## Verification

1. `cd web && npx vitest run`
2. `cd agent && python3 -m pytest test_agent.py -q`
3. focused worker pytest suite
4. `cd web && npm run build`
5. `terraform -chdir=terraform/v2/foundation validate`
6. `terraform plan` with `network_path_check_enabled=false` shows no feature resources or IAM
7. Playwright desktop and mobile screenshots verify no overlap and readable checklist states

## Explicit exclusions

- no AWS Reachability Analyzer creation or execution
- no `kubectl exec`
- no packet injection or active probe
- no SG, NACL, route, firewall, mesh, or Kubernetes mutation
- no autonomous remediation
- no assertion about customer-managed on-premises routers or firewalls
