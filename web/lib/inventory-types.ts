export interface InvColumn { key: string; label: string }
// stateKey: column holding a lifecycle state — drives state KPI tiles + the state filter.
// distKey: column to chart a distribution donut by. Both optional; both reference a columns[].key.
export interface InvType { label: string; group: string; columns: InvColumn[]; stateKey?: string; distKey?: string }

// resource_id + region are prepended by the page; columns here are the type-specific extras.
export const INVENTORY_TYPES: Record<string, InvType> = {
  ec2: { label: 'EC2 Instances', group: 'Compute', stateKey: 'instance_state', distKey: 'instance_type', columns: [
    { key: 'name', label: 'Name' }, { key: 'instance_type', label: 'Type' }, { key: 'instance_state', label: 'State' },
    { key: 'private_ip_address', label: 'Private IP' }, { key: 'public_ip_address', label: 'Public IP' },
    { key: 'subnet_id', label: 'Subnet' }, { key: 'vpc_id', label: 'VPC' }, { key: 'launch_time', label: 'Launch' } ] },
  lambda: { label: 'Lambda Functions', group: 'Compute', stateKey: 'state', distKey: 'runtime', columns: [
    { key: 'runtime', label: 'Runtime' }, { key: 'memory_size', label: 'Mem(MB)' },
    { key: 'timeout', label: 'Timeout(s)' }, { key: 'state', label: 'State' } ] },
  ecs_cluster: { label: 'ECS Clusters', group: 'Compute', stateKey: 'status', distKey: 'status', columns: [
    { key: 'status', label: 'Status' }, { key: 'running_tasks_count', label: 'Running' },
    { key: 'active_services_count', label: 'Services' }, { key: 'registered_container_instances_count', label: 'Instances' } ] },
  ecr: { label: 'ECR Repositories', group: 'Compute', distKey: 'image_tag_mutability', columns: [
    { key: 'repository_uri', label: 'URI' }, { key: 'image_tag_mutability', label: 'Tag mutability' },
    { key: 'created_at', label: 'Created' } ] },
  s3: { label: 'S3 Buckets', group: 'Storage & DB', distKey: 'region', columns: [
    { key: 'creation_date', label: 'Created' } ] },
  ebs_volume: { label: 'EBS Volumes', group: 'Storage & DB', stateKey: 'state', distKey: 'volume_type', columns: [
    { key: 'volume_type', label: 'Type' }, { key: 'size', label: 'Size(GB)' },
    { key: 'state', label: 'State' }, { key: 'encrypted', label: 'Encrypted' }, { key: 'availability_zone', label: 'AZ' } ] },
  rds: { label: 'RDS Instances', group: 'Storage & DB', stateKey: 'status', distKey: 'engine', columns: [
    { key: 'engine', label: 'Engine' }, { key: 'engine_version', label: 'Version' },
    { key: 'class', label: 'Class' }, { key: 'status', label: 'Status' }, { key: 'multi_az', label: 'Multi-AZ' } ] },
  dynamodb: { label: 'DynamoDB Tables', group: 'Storage & DB', stateKey: 'table_status', distKey: 'billing_mode', columns: [
    { key: 'table_status', label: 'Status' }, { key: 'billing_mode', label: 'Billing' },
    { key: 'item_count', label: 'Items' }, { key: 'table_size_bytes', label: 'Size(B)' } ] },
  vpc: { label: 'VPCs', group: 'Network', stateKey: 'state', distKey: 'region', columns: [
    { key: 'cidr_block', label: 'CIDR' }, { key: 'state', label: 'State' },
    { key: 'is_default', label: 'Default' }, { key: 'instance_tenancy', label: 'Tenancy' } ] },
  subnet: { label: 'Subnets', group: 'Network', distKey: 'availability_zone', columns: [
    { key: 'vpc_id', label: 'VPC' }, { key: 'cidr_block', label: 'CIDR' }, { key: 'availability_zone', label: 'AZ' },
    { key: 'available_ip_address_count', label: 'Free IPs' }, { key: 'map_public_ip_on_launch', label: 'Auto-public-IP' } ] },
  security_group: { label: 'Security Groups', group: 'Network', distKey: 'vpc_id', columns: [
    { key: 'group_name', label: 'Name' }, { key: 'vpc_id', label: 'VPC' }, { key: 'description', label: 'Description' } ] },
  iam_role: { label: 'IAM Roles', group: 'Security', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'path', label: 'Path' }, { key: 'role_id', label: 'Role ID' } ] },
  iam_user: { label: 'IAM Users', group: 'Security', distKey: 'mfa_enabled', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'mfa_enabled', label: 'MFA' }, { key: 'password_last_used', label: 'Last PW use' } ] },
  // ---- D3 wave ----
  cloudfront: { label: 'CloudFront', group: 'Network', stateKey: 'status', distKey: 'price_class', columns: [
    { key: 'domain_name', label: 'Domain' }, { key: 'status', label: 'Status' },
    { key: 'enabled', label: 'Enabled' }, { key: 'price_class', label: 'Price class' } ] },
  alb: { label: 'App Load Balancers', group: 'Network', stateKey: 'state_code', distKey: 'scheme', columns: [
    { key: 'scheme', label: 'Scheme' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'state_code', label: 'State' }, { key: 'dns_name', label: 'DNS' } ] },
  nlb: { label: 'Net Load Balancers', group: 'Network', stateKey: 'state_code', distKey: 'scheme', columns: [
    { key: 'scheme', label: 'Scheme' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'state_code', label: 'State' }, { key: 'dns_name', label: 'DNS' } ] },
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
    { key: 'engine_version', label: 'Version' }, { key: 'created', label: 'Created' }, { key: 'deleted', label: 'Deleted' } ] },
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
