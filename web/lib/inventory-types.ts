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
  ecs_service: { label: 'ECS Services', group: 'Compute', stateKey: 'status', distKey: 'launch_type', columns: [
    { key: 'status', label: 'Status' }, { key: 'desired_count', label: 'Desired' },
    { key: 'running_count', label: 'Running' }, { key: 'pending_count', label: 'Pending' },
    { key: 'launch_type', label: 'Launch' }, { key: 'cluster_arn', label: 'Cluster' } ] },
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
  apigatewayv2_route: { label: 'API GW Routes', group: 'Network', columns: [
    { key: 'route_key', label: 'Route' }, { key: 'target', label: 'Integration' },
    { key: 'authorization_type', label: 'Auth' } ] },
  alb_listener_rule: { label: 'ALB Listener Rules', group: 'Network', distKey: 'protocol', columns: [
    { key: 'priority', label: 'Priority' }, { key: 'port', label: 'Port' },
    { key: 'protocol', label: 'Protocol' }, { key: 'is_default', label: 'Default' } ] },
  waf: { label: 'WAF Web ACLs', group: 'Security', distKey: 'scope', columns: [
    { key: 'scope', label: 'Scope' }, { key: 'capacity', label: 'Capacity' },
    { key: 'description', label: 'Description' }, { key: 'managed_by_firewall_manager', label: 'FMS-managed' } ] },
  cloudtrail: { label: 'CloudTrail Trails', group: 'Security', distKey: 'home_region', columns: [
    { key: 'is_logging', label: 'Logging' }, { key: 'is_multi_region_trail', label: 'Multi-region' },
    { key: 'home_region', label: 'Home region' }, { key: 's3_bucket_name', label: 'S3 bucket' }, { key: 'log_file_validation_enabled', label: 'Log validation' } ] },
  s3_public_access: { label: 'S3 Public Access', group: 'Security', distKey: 'bucket_policy_is_public', columns: [
    { key: 'bucket_policy_is_public', label: 'Policy public' }, { key: 'block_public_acls', label: 'Block ACLs' },
    { key: 'block_public_policy', label: 'Block policy' }, { key: 'restrict_public_buckets', label: 'Restrict public' }, { key: 'ignore_public_acls', label: 'Ignore ACLs' } ] },
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

// ───────────────────────────────────────────────────────────────────────────
// Nav tree (sidebar IA) — collapsible groups + 2-level subgroups + per-group
// overview pages. ADDITIVE over inventoryGroups(): that stays the flat source
// for CommandPalette + mobile-tabs; navTree() is the sidebar's hierarchy.
// ───────────────────────────────────────────────────────────────────────────

// summary.splits keys (see app/api/inventory/summary/route.ts) shown on overviews.
export type SplitKey = 'ec2Running' | 'ec2Stopped' | 'ebsUnencrypted' | 'iamUserNoMfa' | 'sgOpenIngress';
// Splits representing something needing attention — drive the overview verdict.
export const ATTENTION_SPLITS: SplitKey[] = ['ec2Stopped', 'ebsUnencrypted', 'sgOpenIngress', 'iamUserNoMfa'];

interface SubgroupMeta { key: string; labelKey: string; types: string[] }
interface GroupMeta {
  slug: string;            // url segment + i18n suffix
  labelKey: string;        // i18n key (Security → "Security Resources")
  singleton?: boolean;     // true → flat render, no overview page
  splitKeys: SplitKey[];   // summary.splits shown on the overview status band
  order: string[];         // explicit order for direct inventory items (not in a subgroup)
  injected?: { key: string; href: string; labelKey: string }[]; // non-inventory feature links (EKS) placed first
  subgroups?: SubgroupMeta[];
}

// Keyed by the INVENTORY_TYPES `.group` display name. GROUP_ORDER drives sidebar order.
// Single bridge: slug ↔ display-group ↔ labelKey ↔ ordering ↔ singleton ↔ splitKeys.
// split→group mapping is pinned here (security_group ∈ Network → sgOpenIngress is Network's).
const GROUPS: Record<string, GroupMeta> = {
  'Compute': {
    slug: 'compute', labelKey: 'group.compute', splitKeys: ['ec2Running', 'ec2Stopped'],
    injected: [{ key: 'eks', href: '/eks', labelKey: 'nav.eks' }],
    order: ['ec2', 'lambda', 'ecr'],
    subgroups: [{ key: 'ecs', labelKey: 'group.compute.ecs', types: ['ecs_cluster', 'ecs_service', 'ecs_task'] }],
  },
  'Storage & DB': {
    slug: 'storage', labelKey: 'group.storage', splitKeys: ['ebsUnencrypted'],
    order: ['s3', 'ebs_volume', 'rds', 'dynamodb', 'elasticache', 'opensearch', 'msk'],
  },
  'Network': {
    slug: 'network', labelKey: 'group.network', splitKeys: ['sgOpenIngress'],
    order: ['vpc', 'subnet', 'security_group', 'route53', 'cloudfront', 'cloudfront_vpc_origin'],
    subgroups: [
      { key: 'loadBalancing', labelKey: 'group.network.loadBalancing', types: ['alb', 'nlb', 'target_group', 'alb_listener_rule'] },
      { key: 'apiGateway', labelKey: 'group.network.apiGateway', types: ['apigatewayv2_api', 'apigatewayv2_integration', 'apigatewayv2_route'] },
    ],
  },
  'Security': {
    slug: 'security', labelKey: 'group.security', splitKeys: ['iamUserNoMfa'],
    order: ['iam_role', 'iam_user', 'waf', 'cloudtrail', 's3_public_access'],
  },
  'Monitoring': {
    slug: 'monitoring', labelKey: 'group.monitoring', singleton: true, splitKeys: [],
    order: ['cloudwatch_alarm'],
  },
};

// Slugs reserved by group overview routes — no inventory type may collide (incl. the 'g' segment).
export const RESERVED_NAV_SLUGS: string[] = ['g', ...Object.values(GROUPS).map((m) => m.slug)];

export type NavLeafKind = 'inventory' | 'feature';
export interface NavLeaf {
  key: string;
  kind: NavLeafKind;
  type?: string;        // inventory slug (kind === 'inventory')
  href: string;
  label?: string;       // literal (inventory: INVENTORY_TYPES[type].label)
  labelKey?: string;    // i18n key (feature links, e.g. EKS)
}
export interface NavSubgroupNode { key: string; labelKey: string; items: NavLeaf[] }
export interface NavGroupNode {
  group: string; slug: string; labelKey: string;
  singleton: boolean; href?: string; splitKeys: SplitKey[];
  items: NavLeaf[]; subgroups: NavSubgroupNode[];
}

function invLeaf(type: string): NavLeaf {
  return { key: type, kind: 'inventory', type, href: `/inventory/${type}`, label: INVENTORY_TYPES[type]?.label ?? type };
}
// Order `types` by `order` (known first, in that order); append any leftover so a
// newly-registered type is never silently dropped from the sidebar.
function ordered(types: string[], order: string[]): string[] {
  const present = new Set(types);
  const head = order.filter((t) => present.has(t));
  const tail = types.filter((t) => !order.includes(t));
  return [...head, ...tail];
}

/** Sidebar hierarchy: collapsible groups (GROUP_ORDER) + 2-level subgroups + injected feature links. */
export function navTree(): NavGroupNode[] {
  return inventoryGroups().map(({ group, types }) => {
    const meta: GroupMeta = GROUPS[group] ?? {
      slug: group.toLowerCase().replace(/[^a-z0-9]+/g, '-'), labelKey: group, splitKeys: [], order: [],
    };
    const subgroupMeta = meta.subgroups ?? [];
    const subMembers = new Set(subgroupMeta.flatMap((s) => s.types));
    const directTypes = ordered(types.filter((t) => !subMembers.has(t)), meta.order);
    const injected: NavLeaf[] = (meta.injected ?? []).map((f) => ({ key: f.key, kind: 'feature', href: f.href, labelKey: f.labelKey }));
    const items: NavLeaf[] = [...injected, ...directTypes.map(invLeaf)];
    const subgroups: NavSubgroupNode[] = subgroupMeta
      .map((s) => ({ key: s.key, labelKey: s.labelKey, items: ordered(types.filter((t) => s.types.includes(t)), s.types).map(invLeaf) }))
      .filter((s) => s.items.length > 0);
    const singleton = !!meta.singleton;
    return {
      group, slug: meta.slug, labelKey: meta.labelKey, singleton,
      href: singleton ? undefined : `/inventory/g/${meta.slug}`,
      splitKeys: meta.splitKeys, items, subgroups,
    };
  });
}

/** Non-singleton groups that own an overview page (server route validation + Cmd-K). */
export function overviewGroups(): NavGroupNode[] {
  return navTree().filter((g) => !g.singleton);
}

/** Resolve a slug to its overview group node, or null if unknown/singleton (→ notFound). */
export function groupBySlug(slug: string): NavGroupNode | null {
  return overviewGroups().find((g) => g.slug === slug) ?? null;
}

/** Map an active pathname to its owning group/subgroup — drives 2-level auto-expand. */
export function groupForPath(path: string): { slug: string; subgroupKey?: string } | null {
  for (const g of navTree()) {
    if (g.href && (path === g.href || path.startsWith(`${g.href}/`))) return { slug: g.slug };
    for (const leaf of g.items) {
      if (leaf.kind === 'feature' && (path === leaf.href || path.startsWith(`${leaf.href}/`))) return { slug: g.slug };
      if (leaf.kind === 'inventory' && leaf.href === path) return { slug: g.slug };
    }
    for (const s of g.subgroups) {
      if (s.items.some((l) => l.href === path)) return { slug: g.slug, subgroupKey: s.key };
    }
  }
  return null;
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

// ───────────────────────────────────────────────────────────────────────────
// Per-type highlight cards — tailored top KPIs so each inventory page reads
// distinctly (vs the old identical total + top-4-state template). Derived ONLY
// from already-synced row columns (no new AWS calls). Types without an entry
// fall back to the generic state-count tiles.
// ───────────────────────────────────────────────────────────────────────────
export type Highlight =
  | { kind: 'countWhere'; label: string; col: string; eq: string; tone?: 'accent' | 'danger' }
  | { kind: 'countTruthy'; label: string; col: string; tone?: 'accent' | 'danger' }
  | { kind: 'distinct'; label: string; col: string }
  | { kind: 'sum'; label: string; col: string; suffix?: string }
  | { kind: 'deprecatedRuntime'; label: string; col: string };

export interface HighlightCard { label: string; value: string | number; variant: 'default' | 'accent' | 'danger' }

const FALSY = new Set(['', 'false', 'null', 'undefined', '0', 'none', 'no', 'disabled']);
const sv = (v: unknown): string => (v == null ? '' : String(v));

/** Compute highlight cards from the full row set. Pure — unit-tested. */
export function computeHighlights(rows: Array<Record<string, unknown>>, highlights: Highlight[]): HighlightCard[] {
  const tone = (t: 'accent' | 'danger' | undefined, n: number): HighlightCard['variant'] =>
    t === 'danger' ? (n > 0 ? 'danger' : 'default') : t === 'accent' ? 'accent' : 'default';
  return highlights.map((h) => {
    switch (h.kind) {
      case 'countWhere': {
        const n = rows.filter((r) => sv(r[h.col]).trim().toLowerCase() === h.eq.toLowerCase()).length;
        return { label: h.label, value: n, variant: tone(h.tone, n) };
      }
      case 'countTruthy': {
        const n = rows.filter((r) => !FALSY.has(sv(r[h.col]).trim().toLowerCase())).length;
        return { label: h.label, value: n, variant: tone(h.tone, n) };
      }
      case 'distinct': {
        const set = new Set(rows.map((r) => sv(r[h.col]).trim()).filter((x) => x !== ''));
        return { label: h.label, value: set.size, variant: 'default' };
      }
      case 'sum': {
        const total = rows.reduce((acc, r) => acc + (Number(r[h.col]) || 0), 0);
        return { label: h.label, value: `${Math.round(total).toLocaleString()}${h.suffix ?? ''}`, variant: 'default' };
      }
      case 'deprecatedRuntime': {
        const n = rows.filter((r) => isDeprecatedRuntime(r[h.col])).length;
        return { label: h.label, value: n, variant: n > 0 ? 'danger' : 'default' };
      }
    }
  });
}

// High-value types first (synced columns only). EKS is a feature route (/eks), not an inventory type.
export const HIGHLIGHTS: Record<string, Highlight[]> = {
  ec2: [
    { kind: 'countWhere', label: '실행 중', col: 'instance_state', eq: 'running', tone: 'accent' },
    { kind: 'countWhere', label: '중지됨', col: 'instance_state', eq: 'stopped', tone: 'danger' },
    { kind: 'countTruthy', label: '퍼블릭 IP', col: 'public_ip_address' },
    { kind: 'distinct', label: '타입 종류', col: 'instance_type' },
  ],
  rds: [
    { kind: 'countWhere', label: '가용', col: 'status', eq: 'available', tone: 'accent' },
    { kind: 'countWhere', label: 'Multi-AZ', col: 'multi_az', eq: 'true', tone: 'accent' },
    { kind: 'countWhere', label: '퍼블릭 노출', col: 'publicly_accessible', eq: 'true', tone: 'danger' },
    { kind: 'distinct', label: '엔진 종류', col: 'engine' },
  ],
  lambda: [
    { kind: 'countWhere', label: '활성', col: 'state', eq: 'active', tone: 'accent' },
    { kind: 'deprecatedRuntime', label: 'EOL 런타임', col: 'runtime' },
    { kind: 'distinct', label: '런타임 종류', col: 'runtime' },
  ],
  ecs_service: [
    { kind: 'sum', label: 'Desired', col: 'desired_count' },
    { kind: 'sum', label: 'Running', col: 'running_count' },
    { kind: 'sum', label: 'Pending', col: 'pending_count' },
    { kind: 'distinct', label: '런치타입', col: 'launch_type' },
  ],
  ebs_volume: [
    { kind: 'countWhere', label: '사용 중', col: 'state', eq: 'in-use', tone: 'accent' },
    { kind: 'countWhere', label: '미암호화', col: 'encrypted', eq: 'false', tone: 'danger' },
    { kind: 'sum', label: '총 용량', col: 'size', suffix: ' GB' },
    { kind: 'distinct', label: '타입 종류', col: 'volume_type' },
  ],
  alb: [
    { kind: 'countWhere', label: '활성', col: 'state_code', eq: 'active', tone: 'accent' },
    { kind: 'countWhere', label: '인터넷 노출', col: 'scheme', eq: 'internet-facing' },
    { kind: 'countWhere', label: '내부', col: 'scheme', eq: 'internal' },
  ],
  nlb: [
    { kind: 'countWhere', label: '활성', col: 'state_code', eq: 'active', tone: 'accent' },
    { kind: 'countWhere', label: '인터넷 노출', col: 'scheme', eq: 'internet-facing' },
    { kind: 'countWhere', label: '내부', col: 'scheme', eq: 'internal' },
  ],
  iam_user: [
    { kind: 'countWhere', label: 'MFA 미설정', col: 'mfa_enabled', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: 'MFA 설정', col: 'mfa_enabled', eq: 'true', tone: 'accent' },
  ],
  cloudwatch_alarm: [
    { kind: 'countWhere', label: 'ALARM', col: 'state_value', eq: 'alarm', tone: 'danger' },
    { kind: 'countWhere', label: 'OK', col: 'state_value', eq: 'ok', tone: 'accent' },
    { kind: 'countWhere', label: '액션 비활성', col: 'actions_enabled', eq: 'false' },
    { kind: 'distinct', label: '네임스페이스', col: 'namespace' },
  ],
  s3: [
    { kind: 'distinct', label: '리전 수', col: 'region' },
  ],
  s3_public_access: [
    { kind: 'countWhere', label: '정책 공개', col: 'bucket_policy_is_public', eq: 'true', tone: 'danger' },
    { kind: 'countWhere', label: '정책차단 해제', col: 'block_public_policy', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: '공개버킷 미제한', col: 'restrict_public_buckets', eq: 'false', tone: 'danger' },
  ],
  cloudtrail: [
    { kind: 'countWhere', label: '로깅 중', col: 'is_logging', eq: 'true', tone: 'accent' },
    { kind: 'countWhere', label: '로깅 꺼짐', col: 'is_logging', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: '검증 비활성', col: 'log_file_validation_enabled', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: '멀티리전', col: 'is_multi_region_trail', eq: 'true', tone: 'accent' },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Layout archetypes — each inventory page composes its sections to match the
// resource's nature, so pages read distinctly (vs one identical template):
//   risk      → danger-verdict hero on top, table-first (security posture)
//   chart     → distribution/utilization donut prominent up top, table below
//   capacity  → donut-left + table-right side-by-side (engine/type/size)
//   directory → compact KPIs, table-dominant scanning, donut as a small aside
// ───────────────────────────────────────────────────────────────────────────
export type Archetype = 'risk' | 'chart' | 'capacity' | 'directory';

const LAYOUTS: Record<string, Archetype> = {
  // risk — types with genuine danger signals → lead with the verdict
  iam_user: 'risk', s3_public_access: 'risk', cloudtrail: 'risk',
  // chart — state/utilization distribution is the story
  ec2: 'chart', lambda: 'chart', ecs_cluster: 'chart', ecs_service: 'chart', cloudwatch_alarm: 'chart',
  // capacity — engine/type/size; donut beside the table
  rds: 'capacity', ebs_volume: 'capacity', dynamodb: 'capacity', elasticache: 'capacity',
  opensearch: 'capacity', msk: 'capacity', s3: 'capacity', ecr: 'capacity',
  // directory — listing/scanning, table-dominant (default for the rest)
  vpc: 'directory', subnet: 'directory', security_group: 'directory', waf: 'directory',
  alb: 'directory', nlb: 'directory', target_group: 'directory', alb_listener_rule: 'directory',
  apigatewayv2_api: 'directory', apigatewayv2_integration: 'directory', apigatewayv2_route: 'directory',
  cloudfront: 'directory', cloudfront_vpc_origin: 'directory', route53: 'directory', ecs_task: 'directory',
};

/** The layout archetype for an inventory type (unmapped → 'directory', a safe table-lead default). */
export const layoutOf = (type: string): Archetype => LAYOUTS[type] ?? 'directory';
