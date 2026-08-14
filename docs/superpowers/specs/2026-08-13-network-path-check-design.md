# Network Path Check

**Status:** Proposed 2026-08-13 — **not yet Approved.** This feature stays read-only (no mutation, no
active probe, per Explicit exclusions below), so it does not raise the ADR-005/ADR-007 governance
question the SG-rules sibling spec does. It still needs a `docs/decisions/BASELINE.md` §2 register row
for `network_path_check_enabled` in the same PR that introduces the flag (BASELINE's anti-drift rule) —
that row does not exist yet, so this document does not move to Approved until it's added alongside the
implementation PR. Separately, this document's own status-reduction rules and adapter-safety
requirements (see review-driven revisions below) need one more pass before implementation starts.

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
  by the global deadline before it ran (`not_run`, see Result semantics)
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
nothing about the adapter inventing a `blocked`. The adapter wrapper for this layer must translate
"no route found because that component isn't modeled" into `?` (unknown), and reserve `X` (blocked) for
cases the adapter actually evaluated and confirmed deny — the underlying function's disclaimer list is
the exact set of conditions that must map to `?` rather than being passed through as `reachable:false`.
Separately, the same adapter probes the NACL return path at a single representative ephemeral port; a
verdict of `allowed` from that adapter is scoped to that probed port only, and the wrapper must not
generalize it to "the real client's ephemeral port is also allowed" without a matching check.

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

**Per-candidate status** (computed independently for each candidate path):

- any `blocked` layer on that candidate -> that candidate is `blocked`
- no `blocked`, at least one required layer `unknown` **or `not_run`** -> that candidate is `conditional`
  (a layer the deadline cut off before evaluation is exactly as informative as one that returned
  `unknown` — neither confirms the candidate works, and letting `not_run` silently drop out of the
  reduction would let a deadline-truncated candidate report `allowed` on partial evidence)
- every required layer `allowed` -> that candidate is `allowed`
- every required layer `not_run` (the deadline hit before this candidate's first layer even started) ->
  that candidate is `failed`, not `conditional` — zero evidence was gathered, which is a different case
  from "some evidence, still uncertain"

**Candidate kind** — `discover` tags each candidate `resolved` or `hypothesis`:
- `resolved`: discovery found genuine, verified redundancy for this specific flow — ECMP routes, a
  multi-target-group/multi-healthy-target ALB backend, multiple healthy TGW attachments — where traffic
  for this flow may legitimately take any of the listed candidates and all of them being viable is the
  actually-correct description of the path.
- `hypothesis`: discovery could not narrow to the single path this flow actually takes (ambiguous source
  ENI/subnet resolution, multiple matching route-table entries with no way to disambiguate) and is
  presenting guesses about which one is real. Forwarding itself is deterministic — exactly one path
  exists — so multiple `hypothesis` candidates encode *our* uncertainty about which one it is, not
  redundancy in the network.

**Overall status** is reduced across candidates, not across layers directly, and the rule depends on
candidate kind:

- **All candidates `resolved`**: at least one `allowed` -> overall `allowed` (redundancy means traffic
  gets through via *some* path; the response surfaces that candidate as primary and lists the
  blocked/conditional candidates as alternates); no `allowed`, at least one `conditional` -> overall
  `conditional`; every candidate `blocked` -> overall `blocked`.
- **Any candidate `hypothesis`**: the reduction may not report `allowed` merely because one hypothesis
  is allowed — that would hide a real blocker on whichever hypothesis is the flow's actual path, which
  is exactly the operator's question. All-hypotheses-agree short-circuits the ambiguity (all `allowed`
  -> overall `allowed`; all `blocked` -> overall `blocked`); any disagreement among hypotheses (some
  allowed, some blocked/conditional) -> overall `conditional`, and the response must say *why* — that
  discovery could not determine which candidate is the real path, not merely that some layer was
  uncertain.
- execution-level failure before meaningful inspection -> `failed`.

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

CREATE TABLE network_path_run_steps (
  run_id        text NOT NULL REFERENCES network_path_runs(id) ON DELETE CASCADE,
  candidate_id  text NOT NULL,
  -- 리뷰 MAJOR: Result semantics의 각 결과는 scope{accountId,region}을 약속하는데(멀티계정/
  -- 멀티리전 워커라 필수), 이 테이블엔 그 두 컬럼이 없었다 — 후보가 계정/리전 경계를
  -- 넘나들면 evidence만으로는 어느 계정/리전에서 관측됐는지 구분이 안 된다.
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
  a `resolved`-kind candidate that reached `allowed` before the deadline still makes the overall result
  `allowed` even if a sibling `resolved` candidate was truncated; a `hypothesis`-kind candidate that
  reached `allowed` does **not** by itself make the overall result `allowed` if a sibling hypothesis was
  truncated to `conditional`/`failed` by the deadline — that's still "we don't know which path is real,
  and couldn't finish checking one of them," which is `conditional`, not `allowed`.
- Identity cannot be resolved -> run completes `failed` with a bounded, non-sensitive error.
- Stale run -> a dedicated reaper query added to `scripts/v2/workers/reaper.py` reconciles
  `network_path_runs` the same way it already does for `worker_jobs`/`diagnosis_reports` — the existing
  reaper does not cover this table today and must be extended as part of this feature's implementation,
  not assumed to already apply.
- Candidate topology is stale or empty -> live discovery continues where possible and records the
  cache limitation.
- Multiple plausible paths -> compute each candidate's status independently, show each candidate with
  its first known blocker (if any), tag each `resolved` or `hypothesis`, and reduce to overall status
  per the candidate-kind reduction rule above (an `allowed` `resolved` candidate makes the overall
  result `allowed` alongside a blocked sibling; an `allowed` `hypothesis` candidate does not, unless
  every hypothesis agrees).
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
- global deadline behavior, including a truncated sibling candidate not downgrading an already-`allowed`
  candidate's contribution to the overall result
- multiple candidate paths, each with independent per-candidate status
- deterministic overall-status reduction: one blocked + one allowed candidate -> overall `allowed`;
  all candidates blocked -> overall `blocked`; no allowed, at least one conditional -> overall `conditional`
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
