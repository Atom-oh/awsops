export interface InvColumn { key: string; label: string }
// stateKey: column holding a lifecycle state — drives state KPI tiles + the state filter.
// distKey: column to chart a distribution donut by. Both optional; both reference a columns[].key.
// sections (optional): group the DetailPanel fields into ordered, labelled sections.
// Each `keys` entry references resource_id/region or a columns[].key; absent keys are skipped,
// leftover keys fall into an "Other" group. Types without `sections` render a flat list.
export interface InvType {
  label: string; group: string; columns: InvColumn[]; stateKey?: string; distKey?: string;
  sections?: { label: string; keys: string[] }[];
}

// resource_id + region are prepended by the page; columns here are the type-specific extras.
export const INVENTORY_TYPES: Record<string, InvType> = {
  ec2: { label: 'EC2 Instances', group: 'Compute', stateKey: 'instance_state', distKey: 'instance_type', columns: [
    { key: 'name', label: 'Name' }, { key: 'instance_type', label: 'Type' }, { key: 'instance_state', label: 'State' },
    { key: 'private_ip_address', label: 'Private IP' }, { key: 'public_ip_address', label: 'Public IP' },
    { key: 'subnet_id', label: 'Subnet' }, { key: 'vpc_id', label: 'VPC' }, { key: 'launch_time', label: 'Launch' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'region'] },
      { label: 'Compute', keys: ['instance_type', 'instance_state', 'launch_time'] },
      { label: 'Network', keys: ['private_ip_address', 'public_ip_address', 'subnet_id', 'vpc_id'] },
    ] },
  lambda: { label: 'Lambda Functions', group: 'Compute', stateKey: 'state', distKey: 'runtime', columns: [
    { key: 'runtime', label: 'Runtime' }, { key: 'memory_size', label: 'Mem(MB)' },
    { key: 'timeout', label: 'Timeout(s)' }, { key: 'state', label: 'State' },
    { key: 'handler', label: 'Handler' }, { key: 'last_modified', label: 'Modified' } ] },
  ecs_cluster: { label: 'ECS Clusters', group: 'Compute', stateKey: 'status', distKey: 'status', columns: [
    { key: 'status', label: 'Status' }, { key: 'running_tasks_count', label: 'Running' },
    { key: 'pending_tasks_count', label: 'Pending' }, { key: 'active_services_count', label: 'Services' },
    { key: 'registered_container_instances_count', label: 'Instances' } ] },
  ecs_task: { label: 'ECS Tasks', group: 'Compute', stateKey: 'last_status', distKey: 'launch_type', columns: [
    { key: 'task_group', label: 'Group' }, { key: 'last_status', label: 'Status' },
    { key: 'launch_type', label: 'Launch' }, { key: 'task_definition_arn', label: 'Task def' } ] },
  ecr: { label: 'ECR Repositories', group: 'Compute', distKey: 'image_tag_mutability', columns: [
    { key: 'repository_uri', label: 'URI' }, { key: 'image_tag_mutability', label: 'Tag mutability' },
    { key: 'created_at', label: 'Created' } ] },
  s3: { label: 'S3 Buckets', group: 'Storage & DB', distKey: 'region', columns: [
    { key: 'creation_date', label: 'Created' } ] },
  ebs_volume: { label: 'EBS Volumes', group: 'Storage & DB', stateKey: 'state', distKey: 'volume_type', columns: [
    { key: 'name', label: 'Name' }, { key: 'volume_type', label: 'Type' }, { key: 'size', label: 'Size(GB)' },
    { key: 'state', label: 'State' }, { key: 'encrypted', label: 'Encrypted' }, { key: 'iops', label: 'IOPS' },
    { key: 'availability_zone', label: 'AZ' }, { key: 'create_time', label: 'Created' } ] },
  rds: { label: 'RDS Instances', group: 'Storage & DB', stateKey: 'status', distKey: 'engine', columns: [
    { key: 'engine', label: 'Engine' }, { key: 'engine_version', label: 'Version' },
    { key: 'class', label: 'Class' }, { key: 'status', label: 'Status' }, { key: 'multi_az', label: 'Multi-AZ' },
    { key: 'publicly_accessible', label: 'Public' }, { key: 'allocated_storage', label: 'Storage(GB)' }, { key: 'vpc_id', label: 'VPC' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'region', 'status'] },
      { label: 'Engine', keys: ['engine', 'engine_version', 'class', 'allocated_storage'] },
      { label: 'Network & HA', keys: ['multi_az', 'publicly_accessible', 'vpc_id'] },
    ] },
  dynamodb: { label: 'DynamoDB Tables', group: 'Storage & DB', stateKey: 'table_status', distKey: 'billing_mode', columns: [
    { key: 'table_status', label: 'Status' }, { key: 'billing_mode', label: 'Billing' },
    { key: 'item_count', label: 'Items' }, { key: 'table_size_bytes', label: 'Size(B)' } ] },
  vpc: { label: 'VPCs', group: 'Network', stateKey: 'state', distKey: 'region', columns: [
    { key: 'name', label: 'Name' }, { key: 'cidr_block', label: 'CIDR' }, { key: 'state', label: 'State' },
    { key: 'is_default', label: 'Default' }, { key: 'instance_tenancy', label: 'Tenancy' }, { key: 'owner_id', label: 'Owner' } ] },
  subnet: { label: 'Subnets', group: 'Network', distKey: 'availability_zone', columns: [
    { key: 'name', label: 'Name' }, { key: 'vpc_id', label: 'VPC' }, { key: 'cidr_block', label: 'CIDR' },
    { key: 'state', label: 'State' }, { key: 'availability_zone', label: 'AZ' },
    { key: 'available_ip_address_count', label: 'Free IPs' }, { key: 'map_public_ip_on_launch', label: 'Auto-public-IP' } ] },
  security_group: { label: 'Security Groups', group: 'Network', distKey: 'vpc_id', columns: [
    { key: 'name', label: 'Name' }, { key: 'group_name', label: 'Group name' },
    { key: 'vpc_id', label: 'VPC' }, { key: 'description', label: 'Description' } ] },
  iam_role: { label: 'IAM Roles', group: 'Security', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'path', label: 'Path' },
    { key: 'role_id', label: 'Role ID' }, { key: 'max_session_duration', label: 'Max session(s)' } ] },
  iam_user: { label: 'IAM Users', group: 'Security', distKey: 'mfa_enabled', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'path', label: 'Path' },
    { key: 'mfa_enabled', label: 'MFA' }, { key: 'password_last_used', label: 'Last PW use' } ] },
  // ---- D3 wave ----
  cloudfront: { label: 'CloudFront', group: 'Network', stateKey: 'status', distKey: 'price_class', columns: [
    { key: 'domain_name', label: 'Domain' }, { key: 'status', label: 'Status' },
    { key: 'enabled', label: 'Enabled' }, { key: 'price_class', label: 'Price class' } ] },
  route53: { label: 'Route53 Records', group: 'Network', distKey: 'type', columns: [
    { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' },
    { key: 'zone_id', label: 'Zone' }, { key: 'ttl', label: 'TTL' } ] },
  alb: { label: 'App Load Balancers', group: 'Network', stateKey: 'state_code', distKey: 'scheme', columns: [
    { key: 'scheme', label: 'Scheme' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'state_code', label: 'State' }, { key: 'dns_name', label: 'DNS' },
    { key: 'ip_address_type', label: 'IP type' }, { key: 'created_time', label: 'Created' } ] },
  nlb: { label: 'Net Load Balancers', group: 'Network', stateKey: 'state_code', distKey: 'scheme', columns: [
    { key: 'scheme', label: 'Scheme' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'state_code', label: 'State' }, { key: 'dns_name', label: 'DNS' },
    { key: 'ip_address_type', label: 'IP type' }, { key: 'created_time', label: 'Created' } ] },
  target_group: { label: 'Target Groups', group: 'Network', distKey: 'target_type', columns: [
    { key: 'target_group_name', label: 'Name' }, { key: 'target_type', label: 'Target type' },
    { key: 'protocol', label: 'Protocol' }, { key: 'port', label: 'Port' },
    { key: 'vpc_id', label: 'VPC' }, { key: 'health_check_path', label: 'Health path' } ] },
  apigatewayv2_api: { label: 'API Gateway (HTTP)', group: 'Network', distKey: 'protocol_type', columns: [
    { key: 'name', label: 'Name' }, { key: 'api_endpoint', label: 'Endpoint' },
    { key: 'protocol_type', label: 'Protocol' } ] },
  apigatewayv2_integration: { label: 'API GW Integrations', group: 'Network', distKey: 'integration_type', columns: [
    { key: 'api_id', label: 'API' }, { key: 'integration_type', label: 'Type' },
    { key: 'connection_type', label: 'Conn' }, { key: 'integration_uri', label: 'Target' } ] },
  cloudfront_vpc_origin: { label: 'CloudFront VPC Origins', group: 'Network', stateKey: 'status', distKey: 'status', columns: [
    { key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }, { key: 'arn', label: 'Target LB' } ] },
  waf: { label: 'WAF Web ACLs', group: 'Security', distKey: 'scope', columns: [
    { key: 'scope', label: 'Scope' }, { key: 'capacity', label: 'Capacity' },
    { key: 'description', label: 'Description' }, { key: 'managed_by_firewall_manager', label: 'FMS-managed' } ] },
  cloudtrail: { label: 'CloudTrail Trails', group: 'Security', distKey: 'home_region', columns: [
    { key: 'is_logging', label: 'Logging' }, { key: 'is_multi_region_trail', label: 'Multi-region' },
    { key: 'home_region', label: 'Home region' }, { key: 's3_bucket_name', label: 'S3 bucket' }, { key: 'log_file_validation_enabled', label: 'Log validation' } ] },
  elasticache: { label: 'ElastiCache', group: 'Storage & DB', stateKey: 'cache_cluster_status', distKey: 'engine', columns: [
    { key: 'engine', label: 'Engine' }, { key: 'engine_version', label: 'Version' },
    { key: 'cache_node_type', label: 'Node type' }, { key: 'cache_cluster_status', label: 'Status' }, { key: 'num_cache_nodes', label: 'Nodes' } ] },
  opensearch: { label: 'OpenSearch', group: 'Storage & DB', distKey: 'engine_version', columns: [
    { key: 'engine_version', label: 'Version' }, { key: 'processing', label: 'Processing' },
    { key: 'created', label: 'Created' }, { key: 'endpoint', label: 'Endpoint' } ] },
  msk: { label: 'MSK Clusters', group: 'Storage & DB', stateKey: 'state', distKey: 'cluster_type', columns: [
    { key: 'state', label: 'State' }, { key: 'cluster_type', label: 'Type' }, { key: 'current_version', label: 'Version' } ] },
  cloudwatch_alarm: { label: 'CloudWatch Alarms', group: 'Monitoring', stateKey: 'state_value', distKey: 'namespace', columns: [
    { key: 'state_value', label: 'State' }, { key: 'metric_name', label: 'Metric' }, { key: 'namespace', label: 'Namespace' },
    { key: 'threshold', label: 'Threshold' }, { key: 'actions_enabled', label: 'Actions' } ] },
};

const GROUP_ORDER = ['Compute', 'Storage & DB', 'Network', 'Security', 'Monitoring'];
export function inventoryGroups(): { group: string; types: string[] }[] {
  return GROUP_ORDER.map((group) => ({
    group, types: Object.keys(INVENTORY_TYPES).filter((t) => INVENTORY_TYPES[t].group === group),
  })).filter((g) => g.types.length > 0);
}

// Lambda runtimes past AWS end-of-support. Static list (no date math / API call) —
// ported from v1 src/app/lambda/page.tsx. Surfaced as an EOL badge in the inventory table.
export const DEPRECATED_RUNTIMES = [
  'python2.7', 'python3.6', 'python3.7',
  'nodejs10.x', 'nodejs12.x', 'nodejs14.x',
  'dotnetcore2.1', 'dotnetcore3.1',
  'ruby2.5', 'ruby2.7', 'java8', 'go1.x',
];
const DEPRECATED_SET = new Set(DEPRECATED_RUNTIMES);

/** True when a Lambda runtime string is a known end-of-support runtime (case/space-insensitive). */
export function isDeprecatedRuntime(runtime: unknown): boolean {
  if (typeof runtime !== 'string') return false;
  return DEPRECATED_SET.has(runtime.trim().toLowerCase());
}
