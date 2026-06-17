'use client';
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
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

const COLUMNS = [
  { key: 'resource_id', label: 'Resource' },
  { key: 'region', label: 'Region' },
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
                  columns={COLUMNS}
                  rows={activeFindings as unknown as Record<string, unknown>[]}
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
