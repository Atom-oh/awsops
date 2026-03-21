'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/dashboard/StatsCard';
import StatusBadge from '@/components/dashboard/StatusBadge';
import PieChartCard from '@/components/charts/PieChartCard';
import DataTable from '@/components/table/DataTable';
import { Box, Play, Clock, XCircle } from 'lucide-react';
import { queries as k8sQ } from '@/lib/queries/k8s';
import { useLanguage } from '@/lib/i18n/LanguageContext';

interface DashboardData {
  [key: string]: { rows: Record<string, unknown>[]; error?: string };
}

export default function K8sPodsPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<DashboardData>({});
  const [_loading, setLoading] = useState(true);

  const fetchData = useCallback(async (bustCache = false) => {
    setLoading(true);
    try {
      const res = await fetch(bustCache ? '/awsops/api/steampipe?bustCache=true' : '/awsops/api/steampipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: {
            podSummary: k8sQ.podSummary,
            podList: k8sQ.podList,
          },
        }),
      });
      setData(await res.json());
    } catch {
      // keep existing data
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const get = (key: string) => data[key]?.rows || [];
  const getFirst = (key: string) => get(key)[0] || {};

  const summary = getFirst('podSummary') as any;
  const pods = get('podList');

  const podStatusData = [
    { name: 'Running', value: Number(summary.running_pods) || 0 },
    { name: 'Pending', value: Number(summary.pending_pods) || 0 },
    { name: 'Failed', value: Number(summary.failed_pods) || 0 },
    { name: 'Succeeded', value: Number(summary.succeeded_pods) || 0 },
  ].filter((d) => d.value > 0);

  return (
    <div className="min-h-screen">
      <Header
        title={t('k8s.podsTitle')}
        subtitle={t('k8s.podsSubtitle')}
        onRefresh={() => fetchData(true)}
      />

      <main className="p-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard label={t('k8s.totalPods')} value={summary.total_pods ?? '-'} icon={Box} color="cyan" />
          <StatsCard label={t('k8s.runningPods')} value={summary.running_pods ?? '-'} icon={Play} color="green" />
          <StatsCard label={t('k8s.pendingPods')} value={summary.pending_pods ?? '-'} icon={Clock} color="orange" />
          <StatsCard label={t('k8s.failedPods')} value={summary.failed_pods ?? '-'} icon={XCircle} color="red" />
        </div>

        {/* Chart */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PieChartCard title="Pod Status Distribution" data={podStatusData} />
        </div>

        {/* Table */}
        <DataTable
          columns={[
            { key: 'name', label: t('k8s.podName') },
            { key: 'namespace', label: t('k8s.namespace') },
            {
              key: 'phase',
              label: t('common.status'),
              render: (value: string) => <StatusBadge status={value ?? 'Unknown'} />,
            },
            { key: 'node_name', label: t('k8s.nodeName') },
            { key: 'creation_timestamp', label: t('common.created') },
          ]}
          data={pods}
        />
      </main>
    </div>
  );
}
