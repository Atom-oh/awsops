# Runbook — grant the Network Path Check access to an EKS cluster's Nodes/Pods

The **Network Path Check** (`network_path_check_enabled`) resolves a pod/node source's LIVE
identity via `resolve_live_identity()` in `scripts/v2/workers/network_path.py` — it GETs
`/api/v1/nodes/{name}` (and, for a pod source, `/api/v1/namespaces/{ns}/pods/{name}`) against the
cluster's own Kubernetes API, presigning the request as the **worker Fargate task role**
(`awsops-v2-worker-task`; the `network_path` job runs entirely inside the worker Fargate task, not
a Lambda — see `network-path.tf`'s own header comment). EKS authorization is **per IAM principal**:
onboarding a cluster only grants the *web task role* an access entry (`eks.tf`) — the *worker task
role* is a different principal and gets `403` on every pod/node check until it has its own entry.

AWSops does **not** create this entry in terraform on purpose: granting a principal k8s access is
the **cluster owner's** decision, and the terraform apply principal may not hold
`eks:CreateAccessEntry` on third-party clusters. So an operator with cluster permissions registers
it out-of-band, same as the istio-read MCP's own access entry
(`docs/runbooks/istio-agent-eks-access.md`).

**Why AdminView, not View (unlike istio-read):** `resolve_live_identity()` GETs `/api/v1/nodes/
{name}` — a **cluster-scoped** resource. `AmazonEKSViewPolicy` (what istio-read uses) mirrors the
k8s `view` ClusterRole, which has **no cluster-scoped resources at all** — `eks.tf`'s own comment
on the web task role's Access Entry notes plainly that "listing nodes 403s" under View. The correct
precedent is `eks.tf`'s **own web task-role Access Entry**, which binds
`AmazonEKSAdminViewPolicy` (cluster scope) for exactly this reason. This grant is READ-ONLY
(`get`/`list`/`watch`), same as View, but additionally covers cluster-scoped kinds; it can also
read Secrets, which is why it is reserved for principals (like this one) that genuinely need
cluster-scoped reads, not handed out by default.

## Prerequisites
- `workers_enabled = true` and the foundation applied (the worker task role exists).
- `network_path_check_enabled = true` (see the README's flag table — this feature only queries
  live K8s/EC2 state for a pod/node source once this AND the Access Entry below are both true;
  without the Access Entry, such a check still runs but fails closed on that one source with a
  bounded "could not resolve pod/node identity" error, per `resolve_live_identity()`'s own
  AccessDenied handling).
- You hold `eks:CreateAccessEntry` + `eks:AssociateAccessPolicy` on the target cluster.

## Grant (idempotent)
```bash
scripts/v2/eks/register-network-path-access.sh <cluster-name> [<cluster-name> ...]
# or, if you can't run terraform output:
ROLE_ARN=arn:aws:iam::<acct>:role/awsops-v2-worker-task \
  scripts/v2/eks/register-network-path-access.sh <cluster-name>
```
The script reads `terraform output -raw worker_task_role_arn`, then runs
`aws eks create-access-entry` + `aws eks associate-access-policy` (AdminViewPolicy, `type=cluster`).

## Verify
```bash
aws eks list-access-entries --cluster-name <cluster-name> | grep worker-task
```
Then create a Network Path Check whose source is a pod/node on that cluster and confirm the run's
live-identity step no longer reports an AccessDenied.

## Revoke
```bash
aws eks delete-access-entry --cluster-name <cluster-name> \
  --principal-arn arn:aws:iam::<acct>:role/awsops-v2-worker-task
```

## Notes
- The worker task role also needs the target account registered (ENABLED row in the `accounts`
  table) and, for a target-account source, the target account's `AWSopsReadOnlyRole` trust policy
  to include this principal — this is the SAME pre-existing target-account trust gap the
  `sg-rules` worker grant shares (see `infra/cfn/awsops-target-account-role.yaml`), not something
  this script or the Access Entry above can fix on its own.
- `resolve_live_identity()` never trusts a check definition's stale `eni_id`/`subnet_id` fields as
  already-verified — every pod/node source is re-confirmed against this live read on every run.
- This grant is per-cluster; a fleet with multiple onboarded clusters needs the script run once per
  cluster that will be used as a Network Path Check source.
