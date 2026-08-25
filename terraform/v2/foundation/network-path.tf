# Network Path Check — saveable, async, read-only network path policy checklist
# (BASELINE.md §2 register row / docs/superpowers/specs/2026-08-13-network-path-check-design.md,
# Approved). EVERY resource/env addition here is gated on local.npc (var.workers_enabled AND
# var.network_path_check_enabled) -> default false/false = 0 resources, $0.
#
# Per BASELINE.md's own wording, this feature's ONLY IAM need is the worker task role's FIRST
# extension to sts:AssumeRole -> AWSopsReadOnlyRole — reusing the existing web/Steampipe/agent
# pattern (workload.tf's task_assume_readonly, steampipe.tf, ai.tf), NOT a new trust relationship.
# No new Lambda, no new broker, no new role: the `network_path` job runs entirely inside the
# existing worker Fargate task (handlers.py's REGISTRY, gated at the call site by
# NETWORK_PATH_CHECK_ENABLED — see local.npc_env_list below), using the SAME worker_task role every
# other job type already runs under. A minimal host-account direct-Describe grant is added
# alongside the AssumeRole grant (mirrors sg-rules.tf's same host-account-bypass reasoning:
# sg_rule_scan.py's `_assumed_session` skips AssumeRole entirely when account_id == HOST_ACCOUNT_ID
# and uses the task's own credentials instead) — read-only Describe/List actions only, no mutation.

locals {
  npc = var.workers_enabled && var.network_path_check_enabled ? 1 : 0
  # Appended into the worker Fargate task's container environment (workers.tf) and the web task's
  # environment (workload.tf) — empty when the gate is off, so concat(base, []) == base (byte-
  # identical task defs, no redeploy) exactly like every other optional-env local in this repo.
  npc_env_list = local.npc == 1 ? [
    { name = "NETWORK_PATH_CHECK_ENABLED", value = "true" },
    # CI review item 7(a): network_path.py's HOST_ACCOUNT_ID reads this env var to detect the
    # host account (e.g. to skip AssumeRole and use the task's own credentials). It was previously
    # set ONLY by the unrelated `sg_rule_activity_enabled` gate's env list (sg-rules.tf) — this
    # feature must not silently depend on that separate flag being enabled too.
    { name = "AWS_ACCOUNT_ID", value = local.acct },
  ] : []
}

############################################################
# Worker Fargate task role (worker_task, workers.tf) — Role A assume grant (the SAME
# AWSopsReadOnlyRole trust boundary sg-rules.tf's worker_task_sg_rule_readonly_assume already
# reuses) + a minimal host-account direct-Describe grant, read-only only. No new role, no new
# trust relationship — see this file's header comment.
############################################################
resource "aws_iam_role_policy" "worker_task_network_path_readonly_assume" {
  count = local.npc
  name  = "${var.project}-worker-task-network-path-readonly-assume"
  role  = aws_iam_role.worker_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Target-account reads (spec: "Target accounts use the existing cross-account role and
        # fail closed if a required read action is not granted"). Same resource ARN pattern as
        # sg-rules.tf's grant on the SAME role name — this is that pattern's reuse, not a
        # duplicate/competing grant (Terraform allows multiple aws_iam_role_policy resources on
        # one role; each is a separate named inline policy).
        Sid      = "AssumeReadOnlyForNetworkPathCheck"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "arn:aws:iam::*:role/AWSopsReadOnlyRole"
      },
      {
        # Host-account case (spec: "Host-account targets use the execution role and do not
        # self-assume AWSopsReadOnlyRole") — read-only Describe/List only, across exactly the
        # layers this feature's adapters evaluate (SG, NACL, routes, TGW, Peering, VPN/DX,
        # Network Firewall, ELBv2 listeners/target health, Route 53 resolution). No mutating verb,
        # no ec2:CreateNetworkInsightsPath/DeleteNetworkInsightsPath (Reachability Analyzer stays
        # unused per the design spec's Explicit exclusions).
        Sid    = "DescribeNetworkPathLayersHostAccount"
        Effect = "Allow"
        Action = [
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSecurityGroupRules",
          "ec2:DescribeNetworkAcls",
          "ec2:DescribeRouteTables",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeVpcPeeringConnections",
          "ec2:DescribeTransitGatewayAttachments",
          "ec2:DescribeTransitGatewayRouteTables",
          "ec2:SearchTransitGatewayRoutes",
          "ec2:DescribeVpnConnections",
          "ec2:DescribeVpnGateways",
          "directconnect:DescribeVirtualInterfaces",
          "directconnect:DescribeConnections",
          "network-firewall:DescribeFirewall",
          "network-firewall:DescribeFirewallPolicy",
          "network-firewall:DescribeRuleGroup",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetHealth",
          "route53resolver:ListResolverEndpoints",
          # Gap 4 (PR #231 follow-up, live source-identity confirmation): describe-cluster is a
          # plain read-only IAM action, additive to this SAME existing statement — it strictly
          # extends the file's own established pattern (a tiny grant alongside the existing
          # sts:AssumeRole extension), not a new trust relationship or new resource. It gives
          # network_path.py's resolve_live_identity() the cluster endpoint + CA needed to presign
          # a k8s-aws-v1. bearer token (identical mechanism to web/lib/eks-incluster.ts /
          # scripts/v2/workers/insight/k8s_events.py).
          #
          # NOT covered by this grant, and deliberately NOT added here (genuine, unresolved infra
          # gap — see the report): the worker task role (or AWSopsReadOnlyRole in a target account)
          # still needs a K8s-level EKS Access Entry on the target cluster before any Pod/Node GET
          # actually authorizes. Per eks.tf's own precedent for the istio-read MCP role, granting a
          # principal K8s access is the CLUSTER OWNER's call, not something this apply principal can
          # always make (may lack eks:CreateAccessEntry on a third-party cluster) — that access entry
          # is registered out-of-band by the operator, the same way istio-read's is
          # (docs/runbooks/istio-agent-eks-access.md's register-istio-access.sh pattern). Until that
          # registration exists for a given cluster, a network_path check whose source is a pod/node
          # on that cluster correctly fails closed with a bounded "could not resolve pod/node..."
          # error (resolve_live_identity()'s own AccessDenied handling) rather than silently trusting
          # the definition's stale fields.
          "eks:DescribeCluster",
          # CI review item 7(b): _default_ec2_lookup()'s DescribeInstances call (resolving a
          # Node's real EC2 instance -> ENI/subnet/VPC) had no corresponding host-account grant
          # here — every host-account node/pod source would fail closed with AccessDenied. This
          # is the same read-only Describe pattern as every other action in this statement.
          "ec2:DescribeInstances",
        ]
        Resource = "*"
      }
    ]
  })
}
