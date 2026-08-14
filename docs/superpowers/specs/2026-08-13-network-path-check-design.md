# Network Path Check

**Status:** Approved 2026-08-13.

## Summary

Add a dedicated, read-only Network Path Check workflow that answers:

> Can this EKS Pod or Node reach that AWS, internet, or on-premises destination for this protocol,
> port, host, and path?

The result is not a binary packet-level guarantee. It is a deterministic checklist of the policy
layers AWSops could inspect:

- `O` - inspected and allowed
- `X` - inspected and blocked
- `?` - not observable or not supported
- `conditional` - no known blocker, but at least one segment remains unknown

The engine evaluates cached topology first, then live read-only AWS and Kubernetes policy data. It
never creates a Reachability Analyzer path, executes `kubectl exec`, changes a rule, or performs any
other AWS-resource mutation. When there is no `X` and every inspectable layer is `O`, AWSops may
render operator-run validation commands. It never runs those commands.

## Existing assets and gaps

### Reused

- `agent/lambda/reachability_read_mcp.py` has deterministic ENI/EC2 SG, NACL, and subnet-route
  evaluation with no Network Insights resource creation.
- `agent/lambda/datasource_diag_mcp.py` has bounded helpers for SG chains, TGW/Peering discovery, and
  Kubernetes service endpoints. Its HTTP reachability helper (`_test_http_connectivity`) is **not**
  reused as-is: it does a raw `urlopen()` with no link-local/IMDS/private-range denial, and this
  feature's destinations can include operator-supplied on-prem/internet hosts (DNS/L7 layer). Before
  implementation, either route that helper's destination input through an `ssrf-guard`-equivalent check
  (`web/lib/ssrf-guard.ts` is the project's reference shape) or confirm the destination never reaches an
  HTTP fetch for this feature's candidates. Either way, response bodies and headers from that helper are
  not persisted into `evidence` — only the bounded pass/fail/latency summary is.
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
- no `blocked`, at least one required `unknown` -> that candidate is `conditional`
- every required layer `allowed` -> that candidate is `allowed`

**Overall status** is then reduced across candidates, not across layers directly:

- at least one candidate `allowed` -> overall `allowed` (traffic has a working path; the response
  surfaces that candidate as primary and lists the blocked/conditional candidates as alternates)
- no candidate `allowed`, at least one candidate `conditional` -> overall `conditional`
- every candidate `blocked` -> overall `blocked`
- execution-level failure before meaningful inspection -> `failed`

This is why "any blocked layer -> blocked" cannot be the overall-status rule directly: a blocked layer
on one candidate says nothing about a sibling candidate that never touches that layer. Blocking is
scoped to the candidate that contains the layer, and only propagates to the overall result once every
candidate is accounted for.

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
  rules above), and the overall status still follows the candidate reduction — a candidate that reached
  `allowed` before the deadline still makes the overall result `allowed`, even if a sibling candidate
  was truncated to `conditional` by the deadline.
- Identity cannot be resolved -> run completes `failed` with a bounded, non-sensitive error.
- Stale run -> existing worker reaper marks it failed.
- Candidate topology is stale or empty -> live discovery continues where possible and records the
  cache limitation.
- Multiple plausible paths -> compute each candidate's status independently, show each candidate with
  its first known blocker (if any), and reduce to overall status per the candidate-reduction rule (any
  `allowed` candidate makes the overall result `allowed`, even alongside a blocked sibling).
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
- HTTP-reachability helper never resolves/fetches an operator-supplied destination without the
  SSRF-guard check (or is confirmed unreachable from this feature's code paths)
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
