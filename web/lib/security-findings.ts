// Security findings derived (read-only) from already-synced `inventory_resources` rows.
// SG/EBS/IAM data is synced by scripts/v2/steampipe/sync_lambda.py; s3_public_access is a
// dedicated denial-safe SDK sync. Severity + remediation are static metadata (not stored).
export type CheckKey = 'public_s3' | 'open_sg' | 'unencrypted_ebs' | 'iam_no_mfa';

export interface Finding {
  check: CheckKey;
  resource_id: string;
  region: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  detail: Record<string, unknown>;
  remediation: string;
}

export const CHECK_META: Record<CheckKey, { label: string; severity: Finding['severity']; remediation: string }> = {
  public_s3: {
    label: 'Public S3 Buckets',
    severity: 'high',
    remediation: 'Enable S3 Block Public Access (account + bucket) and remove public bucket policies/ACLs.',
  },
  open_sg: {
    label: 'Open Security Groups',
    severity: 'high',
    remediation: 'Restrict 0.0.0.0/0 (or ::/0) ingress to known CIDRs; front public services with an ALB/CloudFront.',
  },
  unencrypted_ebs: {
    label: 'Unencrypted EBS Volumes',
    severity: 'medium',
    remediation: 'Enable EBS encryption by default; recreate/snapshot-copy volumes with a KMS key.',
  },
  iam_no_mfa: {
    label: 'IAM Users without MFA',
    severity: 'medium',
    remediation: 'Require MFA for all console users; enforce via an IAM policy condition (aws:MultiFactorAuthPresent).',
  },
};

// Each query returns { resource_id, region, detail } over inventory_resources (account_id='self').
// `detail` carries the JSONB row (data) for the slide-in panel.
// open_sg: the cidr predicate is anchored to the cidr KEY (so a description containing 0.0.0.0/0
// cannot false-trigger) and covers IPv4 0.0.0.0/0 + IPv6 ::/0 in both Steampipe key casings —
// same regex as web/app/api/inventory/summary/route.ts.
export const FINDING_SQL: Record<CheckKey, string> = {
  public_s3: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='s3_public_access'
      AND ( (data->>'bucket_policy_is_public')='true'
         OR (data->>'block_public_acls')='false'
         OR (data->>'block_public_policy')='false' )
    ORDER BY resource_id`,
  open_sg: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='security_group'
      AND (data->'ip_permissions')::text ~ '"(cidr_ip|CidrIp|cidr_ipv6|CidrIpv6)"\\s*:\\s*"(0\\.0\\.0\\.0/0|::/0)"'
    ORDER BY resource_id`,
  unencrypted_ebs: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='ebs_volume'
      AND (data->>'encrypted')='false'
    ORDER BY resource_id`,
  iam_no_mfa: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='iam_user'
      AND (data->>'mfa_enabled')='false'
    ORDER BY resource_id`,
};

export function rowToFinding(
  check: CheckKey,
  row: { resource_id: string; region: string; detail: unknown },
): Finding {
  const meta = CHECK_META[check];
  return {
    check,
    resource_id: row.resource_id,
    region: row.region,
    title: `${meta.label}: ${row.resource_id}`,
    severity: meta.severity,
    detail: (row.detail && typeof row.detail === 'object' ? row.detail : {}) as Record<string, unknown>,
    remediation: meta.remediation,
  };
}
