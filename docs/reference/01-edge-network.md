# Edge and Network

Policy: [BASELINE](../decisions/BASELINE.md). The implemented request path is:

```text
Browser -> CloudFront TLS -> VPC Origin HTTPS:443
        -> internal ALB HTTPS:443 -> Fargate web HTTP:3000
```

## Request path

- [edge.tf](../../terraform/v2/foundation/edge.tf) sets the VPC origin to
  `https-only` with TLS 1.2. The distribution origin uses `var.domain_name`
  so SNI matches the regional ALB certificate.
- [workload.tf](../../terraform/v2/foundation/workload.tf) creates an internal
  ALB, regional ACM certificate, HTTPS listener, and IP target group. The target
  group's health path is `/api/health`.
- ALB ingress on 443 references the CloudFront-managed
  `CloudFront-VPCOrigins-Service-SG`, selected by group name and VPC. The service
  SG admits port 3000 from the ALB SG. Preserve this private path and leave SG
  descriptions unchanged to avoid replacement.
- Dynamic requests use `Managed-CachingDisabled` and `Managed-AllViewer`.
  `/_next/static/*` uses `Managed-CachingOptimized`. Viewer-request authentication
  is attached to both behaviors; see [auth](02-auth.md).
- The configured origin read timeout is 60 seconds and ALB idle timeout is
  120 seconds. The diagnostic [SSE route](../../web/app/api/stream/route.ts)
  emits every 15 seconds. Preserve heartbeat and no-cache/no-transform behavior
  when changing streaming paths.

## Network and state

[network.tf](../../terraform/v2/foundation/network.tf) either creates the VPC and
routing resources or uses supplied VPC/private-subnet IDs through `create_network`.
Downstream resources use the resolved locals. Reuse mode does not create that
network, but other foundation resources still have a plan and cost.

[backend.tf](../../terraform/v2/foundation/backend.tf) defines version constraints
and a partial S3 backend. Local `backend.hcl` supplies the state bucket/key and
native S3 lock configuration; use the checked-in example and initialize with
`-backend-config=backend.hcl`. [providers.tf](../../terraform/v2/foundation/providers.tf)
selects the workload region and the `us-east-1` alias used for edge resources.

## Change and failure checks

For origin failures, inspect certificate/SNI alignment, the managed-SG reference,
listener, targets, and task health before changing access. Do not replace the
managed-SG rule with broad ingress. Origin protocol changes require replacement
planning: preserve `create_before_destroy` and distinct origin names when swapping
an attached origin. The controller applies a reviewed saved plan; do not use
`-auto-approve` or treat a reference example as deployment authorization.
