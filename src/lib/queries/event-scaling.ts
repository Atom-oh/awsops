// Historical metrics + resource state queries for event-scaling (ADR-010 Phase 1)
// 이벤트 스케일링용 이력 메트릭 + 리소스 상태 쿼리 (ADR-010 Phase 1)
//
// CloudWatch metric fetches use AWS CLI (execFileSync). Steampipe queries use pg pool.

import { execFileSync } from 'child_process';
import { runQuery } from '@/lib/steampipe';
import type { MetricsSnapshot, MetricSeries } from '@/lib/event-scaling';

const ID_PATTERN = /^[a-zA-Z0-9._:/\-]+$/;

interface MetricSpec {
  key: string;             // result key
  label: string;
  namespace: string;
  metricName: string;
  unit: string;
  dimensions: Array<{ Name: string; Value: string }>;
  stat?: string;           // default 'Average'
}

// CLI helper / CLI 헬퍼
function awsCli(args: string[], region: string, profile?: string, timeout = 20000): unknown {
  const profileArgs = profile ? ['--profile', profile] : [];
  try {
    const out = execFileSync(
      'aws',
      [...args, '--region', region, ...profileArgs, '--output', 'json'],
      { encoding: 'utf-8', timeout },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Build a default metric set for a "general" snapshot — common AWS resource KPIs
export function buildDefaultMetricSpecs(opts: {
  ec2InstanceIds?: string[];
  rdsInstanceIds?: string[];
  mskClusterNames?: string[];
  elbArns?: string[];
}): MetricSpec[] {
  const specs: MetricSpec[] = [];

  for (const id of opts.ec2InstanceIds || []) {
    if (!ID_PATTERN.test(id)) continue;
    specs.push({
      key: `ec2.${id}.cpu`,
      label: `EC2 ${id} CPU`,
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      unit: 'Percent',
      dimensions: [{ Name: 'InstanceId', Value: id }],
    });
    specs.push({
      key: `ec2.${id}.netIn`,
      label: `EC2 ${id} NetworkIn`,
      namespace: 'AWS/EC2',
      metricName: 'NetworkIn',
      unit: 'Bytes',
      dimensions: [{ Name: 'InstanceId', Value: id }],
    });
  }

  for (const id of opts.rdsInstanceIds || []) {
    if (!ID_PATTERN.test(id)) continue;
    specs.push({
      key: `rds.${id}.cpu`,
      label: `RDS ${id} CPU`,
      namespace: 'AWS/RDS',
      metricName: 'CPUUtilization',
      unit: 'Percent',
      dimensions: [{ Name: 'DBInstanceIdentifier', Value: id }],
    });
    specs.push({
      key: `rds.${id}.connections`,
      label: `RDS ${id} Connections`,
      namespace: 'AWS/RDS',
      metricName: 'DatabaseConnections',
      unit: 'Count',
      dimensions: [{ Name: 'DBInstanceIdentifier', Value: id }],
    });
  }

  for (const name of opts.mskClusterNames || []) {
    if (!ID_PATTERN.test(name)) continue;
    specs.push({
      key: `msk.${name}.bytesIn`,
      label: `MSK ${name} BytesIn`,
      namespace: 'AWS/Kafka',
      metricName: 'BytesInPerSec',
      unit: 'Bytes/s',
      dimensions: [{ Name: 'Cluster Name', Value: name }],
      stat: 'Sum',
    });
  }

  for (const arn of opts.elbArns || []) {
    // ALB target ARN format: targetgroup/<name>/<id> — leave as-is for dimension value
    specs.push({
      key: `elb.${arn}.requests`,
      label: `ELB ${arn} RequestCount`,
      namespace: 'AWS/ApplicationELB',
      metricName: 'RequestCount',
      unit: 'Count',
      dimensions: [{ Name: 'LoadBalancer', Value: arn }],
      stat: 'Sum',
    });
    specs.push({
      key: `elb.${arn}.5xx`,
      label: `ELB ${arn} HTTPCode_Target_5XX`,
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      unit: 'Count',
      dimensions: [{ Name: 'LoadBalancer', Value: arn }],
      stat: 'Sum',
    });
  }

  return specs;
}

// Fetch CloudWatch series for a window (returns up to 1440 datapoints)
export async function fetchCloudWatchWindow(
  specs: MetricSpec[],
  windowStartIso: string,
  windowEndIso: string,
  region: string,
  profile?: string,
): Promise<Record<string, MetricSeries>> {
  if (specs.length === 0) return {};

  const period = pickPeriod(windowStartIso, windowEndIso);
  const queries = specs.map((s, idx) => ({
    Id: `m${idx}`,
    MetricStat: {
      Metric: {
        Namespace: s.namespace,
        MetricName: s.metricName,
        Dimensions: s.dimensions,
      },
      Period: period,
      Stat: s.stat || 'Average',
    },
    ReturnData: true,
  }));

  const out: Record<string, MetricSeries> = {};
  // Batch 5 specs per call (CW limit 500 metrics, but stay safe)
  const batchSize = 100;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const specBatch = specs.slice(i, i + batchSize);
    const result = awsCli(
      [
        'cloudwatch', 'get-metric-data',
        '--metric-data-queries', JSON.stringify(batch),
        '--start-time', windowStartIso,
        '--end-time', windowEndIso,
      ],
      region,
      profile,
    ) as { MetricDataResults?: Array<{ Id: string; Timestamps: string[]; Values: number[] }> } | null;

    if (!result?.MetricDataResults) continue;
    for (const r of result.MetricDataResults) {
      const idx = parseInt(r.Id.replace('m', ''), 10);
      const spec = specBatch[idx - i];
      if (!spec) continue;
      const datapoints = r.Timestamps.map((t, j) => ({ t, v: r.Values[j] }))
        .sort((a, b) => a.t.localeCompare(b.t));
      const values = datapoints.map(d => d.v).filter(v => Number.isFinite(v));
      out[spec.key] = {
        label: spec.label,
        unit: spec.unit,
        datapoints,
        peak: values.length ? Math.max(...values) : undefined,
        avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined,
      };
    }
  }

  return out;
}

// Pick a sensible period (in seconds) given the window length / 윈도우 길이에 맞는 period 선택
function pickPeriod(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  const hours = ms / 3_600_000;
  if (hours <= 3) return 60;        // 1-min
  if (hours <= 24) return 300;      // 5-min
  if (hours <= 24 * 7) return 1800; // 30-min
  return 3600;                      // 1-hour
}

// --- Steampipe: current resource state (used as input to plan generation) ---

export async function fetchCurrentResourceState(accountId?: string): Promise<Record<string, unknown>> {
  const safeQuery = async (sql: string): Promise<unknown[]> => {
    try {
      const result = await runQuery(sql, { accountId, ttl: 60 });
      return result.rows || [];
    } catch {
      return [];
    }
  };

  const [asgs, rds, msk, ebs, alb] = await Promise.all([
    safeQuery(`SELECT name, min_size, max_size, desired_capacity FROM aws_ec2_autoscaling_group LIMIT 50`),
    safeQuery(`SELECT db_instance_identifier, class AS instance_class, engine, multi_az, allocated_storage FROM aws_rds_db_instance LIMIT 50`),
    safeQuery(`SELECT cluster_name, arn, provisioned->'numberOfBrokerNodes' AS broker_count FROM aws_msk_cluster LIMIT 30`),
    safeQuery(`SELECT volume_id, size, volume_type, iops, throughput FROM aws_ebs_volume WHERE volume_type IN ('io1','io2','gp3') LIMIT 50`),
    safeQuery(`SELECT name, arn, type, scheme FROM aws_ec2_application_load_balancer LIMIT 30`),
  ]);

  return {
    autoScalingGroups: asgs,
    rdsInstances: rds,
    mskClusters: msk,
    provisionedEbsVolumes: ebs,
    applicationLoadBalancers: alb,
  };
}

// --- Snapshot orchestrator: build a MetricsSnapshot for a reference event ---

export interface BuildSnapshotOptions {
  windowStart: string;          // ISO 8601
  windowEnd: string;
  region: string;
  profile?: string;
  ec2InstanceIds?: string[];
  rdsInstanceIds?: string[];
  mskClusterNames?: string[];
  elbArns?: string[];
  includeSteampipeSnapshot?: boolean;
  accountId?: string;
}

export async function buildMetricsSnapshot(opts: BuildSnapshotOptions): Promise<MetricsSnapshot> {
  const specs = buildDefaultMetricSpecs({
    ec2InstanceIds: opts.ec2InstanceIds,
    rdsInstanceIds: opts.rdsInstanceIds,
    mskClusterNames: opts.mskClusterNames,
    elbArns: opts.elbArns,
  });

  const cw = await fetchCloudWatchWindow(specs, opts.windowStart, opts.windowEnd, opts.region, opts.profile);
  const steampipe = opts.includeSteampipeSnapshot ? await fetchCurrentResourceState(opts.accountId) : undefined;

  return {
    collectedAt: new Date().toISOString(),
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    cloudwatch: cw,
    steampipe,
  };
}
