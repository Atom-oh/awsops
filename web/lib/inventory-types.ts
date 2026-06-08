export interface InvColumn { key: string; label: string }
export interface InvType { label: string; group: string; columns: InvColumn[] }

// resource_id + region are prepended by the page; columns here are the type-specific extras.
export const INVENTORY_TYPES: Record<string, InvType> = {
  ec2: { label: 'EC2 Instances', group: 'Compute', columns: [
    { key: 'instance_type', label: 'Type' }, { key: 'instance_state', label: 'State' },
    { key: 'private_ip_address', label: 'Private IP' }, { key: 'vpc_id', label: 'VPC' } ] },
  lambda: { label: 'Lambda Functions', group: 'Compute', columns: [
    { key: 'runtime', label: 'Runtime' }, { key: 'memory_size', label: 'Mem(MB)' },
    { key: 'timeout', label: 'Timeout(s)' }, { key: 'state', label: 'State' } ] },
  ecs_cluster: { label: 'ECS Clusters', group: 'Compute', columns: [
    { key: 'status', label: 'Status' }, { key: 'running_tasks_count', label: 'Running' },
    { key: 'active_services_count', label: 'Services' }, { key: 'registered_container_instances_count', label: 'Instances' } ] },
  ecr: { label: 'ECR Repositories', group: 'Compute', columns: [
    { key: 'repository_uri', label: 'URI' }, { key: 'image_tag_mutability', label: 'Tag mutability' },
    { key: 'created_at', label: 'Created' } ] },
  s3: { label: 'S3 Buckets', group: 'Storage & DB', columns: [
    { key: 'creation_date', label: 'Created' } ] },
  ebs_volume: { label: 'EBS Volumes', group: 'Storage & DB', columns: [
    { key: 'volume_type', label: 'Type' }, { key: 'size', label: 'Size(GB)' },
    { key: 'state', label: 'State' }, { key: 'encrypted', label: 'Encrypted' }, { key: 'availability_zone', label: 'AZ' } ] },
  rds: { label: 'RDS Instances', group: 'Storage & DB', columns: [
    { key: 'engine', label: 'Engine' }, { key: 'engine_version', label: 'Version' },
    { key: 'class', label: 'Class' }, { key: 'status', label: 'Status' }, { key: 'multi_az', label: 'Multi-AZ' } ] },
  dynamodb: { label: 'DynamoDB Tables', group: 'Storage & DB', columns: [
    { key: 'table_status', label: 'Status' }, { key: 'billing_mode', label: 'Billing' },
    { key: 'item_count', label: 'Items' }, { key: 'table_size_bytes', label: 'Size(B)' } ] },
  vpc: { label: 'VPCs', group: 'Network', columns: [
    { key: 'cidr_block', label: 'CIDR' }, { key: 'state', label: 'State' },
    { key: 'is_default', label: 'Default' }, { key: 'instance_tenancy', label: 'Tenancy' } ] },
  subnet: { label: 'Subnets', group: 'Network', columns: [
    { key: 'vpc_id', label: 'VPC' }, { key: 'cidr_block', label: 'CIDR' }, { key: 'availability_zone', label: 'AZ' },
    { key: 'available_ip_address_count', label: 'Free IPs' }, { key: 'map_public_ip_on_launch', label: 'Auto-public-IP' } ] },
  security_group: { label: 'Security Groups', group: 'Network', columns: [
    { key: 'group_name', label: 'Name' }, { key: 'vpc_id', label: 'VPC' }, { key: 'description', label: 'Description' } ] },
  iam_role: { label: 'IAM Roles', group: 'Security', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'path', label: 'Path' }, { key: 'role_id', label: 'Role ID' } ] },
  iam_user: { label: 'IAM Users', group: 'Security', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'mfa_enabled', label: 'MFA' }, { key: 'password_last_used', label: 'Last PW use' } ] },
};

const GROUP_ORDER = ['Compute', 'Storage & DB', 'Network', 'Security'];
export function inventoryGroups(): { group: string; types: string[] }[] {
  return GROUP_ORDER.map((group) => ({
    group, types: Object.keys(INVENTORY_TYPES).filter((t) => INVENTORY_TYPES[t].group === group),
  })).filter((g) => g.types.length > 0);
}
