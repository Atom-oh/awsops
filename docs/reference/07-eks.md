# EKS Access and Registration

Policy: [BASELINE](../decisions/BASELINE.md). Infrastructure access grants are
operator-managed; the application's Kubernetes proxy is read-only.

## Terraform-managed access

[configure.mjs](../../scripts/v2/configure.mjs) discovers host-account clusters
and checks for `API`/`API_AND_CONFIG_MAP` authentication before writing
`onboard_eks_clusters`. A CONFIG_MAP-only cluster needs operator handoff.

[eks.tf](../../terraform/v2/foundation/eks.tf) creates the web task role's
STANDARD Access Entry and cluster-scoped **AmazonEKSAdminViewPolicy** association.
It also exports endpoint/ARN/CA information. The default cluster list is empty.
This path manages host-account access; it is not a cross-account onboarding engine.

AdminView can read sensitive kinds, so
[eks-incluster.ts](../../web/lib/eks-incluster.ts) is an essential response boundary:
GET-only requests, allowed kinds, field normalization, and restricted describe
operations. Secrets are not exposed; ConfigMaps are metadata-only. Preserve the
negative-kind tests when extending the proxy. Kubernetes HTTPS uses the cluster
CA and a 4-second request timeout.

The Istio agent has a separate operator-granted access path using
**AmazonEKSViewPolicy**. That tool-specific policy does not replace the web role's
AdminView binding. See [Istio access](../runbooks/istio-agent-eks-access.md).

## Runtime registration

[eks-registry.ts](../../web/lib/eks-registry.ts) combines `ONBOARDED_EKS_CLUSTERS`
with Aurora `eks_registrations`. The allowed-set and auth caches are per-task,
30-second caches. A registry failure falls back to the environment set; an auth
read failure falls back to task-role credentials.

[POST/DELETE registration](../../web/app/api/eks/[cluster]/register/route.ts)
requires a verified admin and validates the cluster name. POST also verifies
cluster existence. The default credential path checks access before declaring
success. The route can instead
store validated service-account-token or assume-role auth for a known cluster;
these are implemented options, not proof of general cross-account discovery.
Responses expose auth mode, not credential values. Deleting a runtime registration
does not revoke AWS access; Terraform-managed entries must be changed in Terraform.
Not-found and registry-unavailable responses remain distinct.

## Out-of-band observation

`eks_auto_register_enabled && workers_enabled` gates the CloudTrail/EventBridge
observer in `eks.tf`. [auto_register.py](../../scripts/v2/eks/auto_register.py)
reflects matching task-role policy associations and Access Entry deletions into
Aurora; it does not create AWS access. Read-only policy associations are allowlisted.
This observer does not process every policy-change event, so do not describe it
as a complete continuous authorization reconciler. Check actual access and registry
state when diagnosing stale registration.

The EKS UI and Kubernetes queries are implemented. OpenCost setup is a generated
bundle that an operator runs; it is not an app-executed cluster mutation. Discover
current cluster membership from the configured environment/registry and AWS access
state, not a dated cluster count in documentation.
