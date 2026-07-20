'use client';
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Archive, BrickWall, HardDrive, Users, Shield, Bug, type LucideIcon } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import DataTable from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import SegmentedControl from '@/components/ui/SegmentedControl';
import RefreshButton from '@/components/ui/RefreshButton';
import { CHECK_META, type CheckKey, type Finding } from '@/lib/security-findings';

const CHECKS = Object.keys(CHECK_META) as CheckKey[];

// v1-parity KPI glyphs — per-check icon in the tile's translucent top-right box.
const CHECK_ICON: Record<CheckKey, LucideIcon> = {
  public_s3: Archive, open_sg: BrickWall, unencrypted_ebs: HardDrive, iam_no_mfa: Users, ecr_cve: Bug,
};

interface ApiResp {
  enabled: boolean;
  summary: Partial<Record<CheckKey, number>>;
  findings: Partial<Record<CheckKey, Finding[]>>;
}

const SEV_TONE: Record<Finding['severity'], 'negative' | 'brand' | 'neutral'> = {
  high: 'negative',
  medium: 'brand',
  low: 'neutral',
};

// v1 parity: each check exposes its own high-value columns (from the finding's detail JSONB,
// flattened into the row below). Common prefix: resource / region.
const CHECK_COLUMNS: Record<CheckKey, { key: string; label: string }[]> = {
  public_s3: [
    { key: 'bucket_policy_is_public', label: 'Policy Public' },
    { key: 'block_public_policy', label: 'Block Policy' },
    { key: 'restrict_public_buckets', label: 'Restrict' },
    { key: 'block_public_acls', label: 'Block ACLs' },
  ],
  open_sg: [
    { key: 'name', label: 'Name' },
    { key: 'vpc_id', label: 'VPC' },
    { key: 'owner_id', label: 'Owner' },
  ],
  unencrypted_ebs: [
    { key: 'volume_type', label: 'Type' },
    { key: 'size', label: 'Size(GB)' },
    { key: 'state', label: 'State' },
    { key: 'availability_zone', label: 'AZ' },
  ],
  iam_no_mfa: [
    { key: 'create_date', label: 'Created' },
    { key: 'password_last_used', label: 'Last PW Use' },
  ],
  ecr_cve: [
    { key: 'image_tag', label: 'Image' },
    { key: 'critical', label: 'Critical' },
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'total', label: 'Total' },
    { key: 'scan_completed_at', label: 'Scanned' },
  ],
};
const columnsFor = (k: CheckKey) => [
  { key: 'resource_id', label: 'Resource' },
  { key: 'region', label: 'Region' },
  ...CHECK_COLUMNS[k],
  { key: 'severity', label: 'Severity' },
];

export default function SecurityPage() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [active, setActive] = useState<CheckKey>(CHECKS[0]);
  const [selected, setSelected] = useState<Finding | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch('/api/security');
      const body = (await res.json()) as ApiResp;
      setData(body);
    } catch {
      setErr('보안 점검 데이터를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/security/refresh', { method: 'POST' });
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  const enabled = data?.enabled ?? true;
  const summary = data?.summary ?? {};
  const findings = data?.findings ?? {};

  // Severity rollup for the donut (high vs medium).
  const sevData = (() => {
    let high = 0;
    let medium = 0;
    for (const k of CHECKS) {
      const n = summary[k] ?? 0;
      if (CHECK_META[k].severity === 'high') high += n;
      else if (CHECK_META[k].severity === 'medium') medium += n;
    }
    return [
      { name: 'High', value: high },
      { name: 'Medium', value: medium },
    ];
  })();

  const activeFindings = findings[active] ?? [];

  return (
    <div>
      <PageHeader
        title="Security"
        subtitle="Public S3 · Open Security Groups · Unencrypted EBS · IAM MFA — read-only posture from inventory"
        right={<RefreshButton busy={busy} onClick={refresh} />}
      />
      <div className="px-8 py-6">
        {err && <Card className="mb-4 text-[14px] text-brand-700">{err}</Card>}

        {data && !enabled ? (
          <Card className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-ink-400" />
            <div>
              <div className="text-[15px] font-semibold text-ink-800">Security inventory is disabled</div>
              <p className="mt-1 text-[14px] text-ink-500">
                Steampipe inventory sync is off or has not run yet. Enable the Steampipe inventory
                (steampipe_enabled) and run a sync to populate security findings.
              </p>
            </div>
          </Card>
        ) : (
          <>
            {/* Per-check counts */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {CHECKS.map((k) => (
                <StatTile
                  key={k}
                  label={CHECK_META[k].label}
                  value={summary[k] ?? 0}
                  variant={(summary[k] ?? 0) > 0 ? 'danger' : 'default'}
                  icon={(() => { const I = CHECK_ICON[k] ?? Shield; return <I size={16} />; })()}
                  hint={`${CHECK_META[k].severity} severity`}
                />
              ))}
            </div>

            {/* Severity distribution */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <DonutBreakdown title="Findings by severity" data={sevData} nameKey="name" valueKey="value" />
            </div>

            {/* Tabs + table */}
            <div className="mt-6">
              <SegmentedControl
                options={CHECKS.map((k) => ({ value: k, label: `${CHECK_META[k].label} (${summary[k] ?? 0})` }))}
                value={active}
                onChange={(v) => setActive(v as CheckKey)}
              />
              <div className="mt-3">
                <DataTable
                  columns={columnsFor(active)}
                  rows={activeFindings.map((f) => ({ ...(f.detail as object), ...f })) as unknown as Record<string, unknown>[]}
                  onRowClick={(row) => setSelected(row as unknown as Finding)}
                  cardTitleKey="resource_id"
                />
              </div>
            </div>
          </>
        )}
      </div>

      <DetailPanel
        title={selected?.resource_id}
        data={
          selected
            ? {
                resource_id: selected.resource_id,
                region: selected.region,
                severity: selected.severity,
                remediation: selected.remediation,
                ...selected.detail,
              }
            : null
        }
        onClose={() => setSelected(null)}
        actions={
          selected ? (
            <Badge tone={SEV_TONE[selected.severity]} variant="soft">
              {selected.severity}
            </Badge>
          ) : undefined
        }
      />
    </div>
  );
}
