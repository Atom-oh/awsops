# Independent operator runtime release access. Never grant Terraform state access
# to this role; an operator exports only github_actions_runtime_metadata below.
variable "github_actions_runtime_enabled" {
  type        = bool
  default     = false
  description = "Explicitly enable the origin/production runtime-release role; no component flags are changed."
}
variable "github_actions_runtime_secret_kms_key_arns" {
  type        = list(string)
  default     = []
  description = "Optional explicit KMS keys for the approved integration secret; database decryption belongs to the private task."
}
variable "github_actions_runtime_secret_arns" {
  type        = list(string)
  default     = []
  description = "Optional explicit project integration secret ARN only. Never grant migration master/reader secrets directly to CI."
}
variable "github_actions_runtime_subnet_ids" {
  type        = list(string)
  default     = []
  description = "Explicit existing AgentCore subnet IDs; required for AgentCore create permissions."
}
variable "github_actions_runtime_security_group_ids" {
  type        = list(string)
  default     = []
  description = "Explicit existing AgentCore security-group IDs; no network resources are changed."
}

module "github_actions_runtime" {
  source            = "./modules/github-actions-runtime"
  enabled           = var.github_actions_runtime_enabled
  migration_enabled = var.github_actions_migration != null
  account_id        = data.aws_caller_identity.current.account_id
  project           = var.project
  region            = var.region
  repository        = "Atom-oh/awsops"
  environment       = "production"
  # Identifiers only: targeting this module must not pull role, database or VPC
  # resources into the apply graph. Existing component flags remain unchanged.
  agentcore_role_arn   = var.agentcore_enabled ? "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-agentcore" : null
  worker_task_role_arn = var.workers_enabled ? "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-worker-task" : null
  execution_role_arn   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-task-execution"
  subnets              = var.github_actions_runtime_subnet_ids
  security_groups      = var.github_actions_runtime_security_group_ids
  secret_arns          = var.github_actions_runtime_secret_arns
  secret_kms_key_arns  = var.github_actions_runtime_secret_kms_key_arns
}

resource "aws_iam_role_policy_attachment" "github_actions_runtime_migration" {
  count      = var.github_actions_runtime_enabled && var.github_actions_migration != null ? 1 : 0
  role       = "${var.project}-ci-runtime"
  policy_arn = module.github_actions_migration.controller_policy_arn
  depends_on = [module.github_actions_runtime]
}

output "github_actions_runtime_role_arn" {
  value = module.github_actions_runtime.role_arn
}

# Strict v1 metadata handoff. Only identifiers, endpoints, image references and
# existing governed flags are exported. Do not add raw state/tfvars, generated
# passwords, secret strings, edge HMACs or arbitrary container environment maps.
output "github_actions_runtime_metadata" {
  description = "Operator-only export to protected production AWSOPS_RUNTIME_METADATA_JSON; CI cannot read Terraform state."
  value = {
    version    = 1
    account_id = data.aws_caller_identity.current.account_id
    project    = var.project
    region     = var.region
    migration = {
      aurora_endpoint             = aws_rds_cluster.aurora.endpoint
      aurora_database             = aws_rds_cluster.aurora.database_name
      aurora_secret_arn           = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      agent_sql_reader_secret_arn = try(aws_secretsmanager_secret.agent_sql_reader[0].arn, null)
    }
    components = {
      worker = var.workers_enabled ? {
        repository_uri      = aws_ecr_repository.worker[0].repository_url
        cluster_arn         = aws_ecs_cluster.main.arn
        task_definition_arn = aws_ecs_task_definition.worker[0].arn
        state_machine_arn   = aws_sfn_state_machine.workers[0].arn
        image               = jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].image
        execution_role_arn  = aws_iam_role.execution.arn
        task_role_arn       = aws_iam_role.worker_task[0].arn
        network = { awsvpcConfiguration = {
          subnets = local.private_subnet_ids, securityGroups = [aws_security_group.service.id], assignPublicIp = "DISABLED"
        } }
      } : null
      steampipe = var.steampipe_enabled ? {
        repository_uri      = aws_ecr_repository.steampipe[0].repository_url
        cluster_arn         = aws_ecs_cluster.main.arn
        task_definition_arn = aws_ecs_task_definition.steampipe[0].arn
        service_arn         = aws_ecs_service.steampipe[0].id
        image               = jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].image
      } : null
      agentcore = var.agentcore_enabled ? {
        cloudfront_id = aws_cloudfront_distribution.main.id
        provision = {
          project                      = var.project
          region                       = var.region
          ecr_uri                      = aws_ecr_repository.agentcore[0].repository_url
          role_arn                     = aws_iam_role.agentcore[0].arn
          lambda_arns                  = { for key, fn in aws_lambda_function.agent : key => fn.arn }
          ssm_runtime_arn              = aws_ssm_parameter.agentcore_runtime_arn[0].name
          ssm_memory_id                = aws_ssm_parameter.agentcore_memory_id[0].name
          ssm_interpreter_id           = aws_ssm_parameter.agentcore_interpreter_id[0].name
          subnets                      = local.private_subnet_ids
          security_groups              = [aws_security_group.service.id]
          deployment_readiness_enabled = var.ci_readiness_enabled
          official_mcp_endpoints       = local.official_mcp_count > 0 ? var.official_mcp_endpoints : {}
          official_mcp_read_only_ack   = local.official_mcp_count > 0 ? var.official_mcp_read_only_ack : {}
          integrations_secret_name     = try(aws_secretsmanager_secret.integrations[0].arn, null)
        }
      } : null
    }
  }
}
