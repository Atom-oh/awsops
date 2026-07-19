import {
  Search, Server, Zap, Boxes, Package, Archive, HardDrive, Camera, Database, Table2,
  DatabaseZap, Radio, Network, Split, BrickWall, Scale, Target, Globe, ListFilter,
  FileSearch, Bell, KeyRound, Users, Shield, Activity,
  AlertTriangle, AlertCircle, CheckCircle2, Circle, type LucideIcon,
} from 'lucide-react';

// v1-parity KPI glyphs (v1 StatsCard used lucide icons in a translucent corner box, not emoji).
// Shared by the inventory type page, the dashboard resource tiles, and group overviews so a
// resource type renders the SAME icon everywhere. Per-type icon for total tiles; a group
// fallback covers unlisted types.
export const TYPE_ICON: Record<string, LucideIcon> = {
  ec2: Server, lambda: Zap, ecs_cluster: Boxes, ecs_service: Boxes, ecs_task: Boxes, ecr: Package,
  s3: Archive, ebs_volume: HardDrive, ebs_snapshot: Camera, rds: Database, dynamodb: Table2,
  elasticache: DatabaseZap, opensearch: Search, msk: Radio, vpc: Network, subnet: Split,
  security_group: BrickWall, alb: Scale, nlb: Scale, target_group: Target,
  cloudfront: Globe, cloudfront_vpc_origin: Globe, alb_listener_rule: ListFilter,
  waf: BrickWall, cloudtrail: FileSearch, cloudwatch_alarm: Bell,
  iam_role: KeyRound, iam_user: Users, route53: Globe,
  apigatewayv2_api: Network, apigatewayv2_stage: Network,
};

export const GROUP_ICON: Record<string, LucideIcon> = {
  Compute: Server, 'Storage & DB': Database, Network: Network, Security: Shield, Monitoring: Activity,
};

/** KPI health glyph by tile variant (총 tile uses the type icon; state tiles use these). */
export function variantIcon(v: 'default' | 'accent' | 'danger' | 'warn'): LucideIcon {
  return v === 'danger' ? AlertTriangle : v === 'warn' ? AlertCircle : v === 'accent' ? CheckCircle2 : Circle;
}
