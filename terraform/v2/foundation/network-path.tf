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
        ]
        Resource = "*"
      }
    ]
  })
}
