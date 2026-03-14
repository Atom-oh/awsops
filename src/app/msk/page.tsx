'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/dashboard/StatsCard';
import PieChartCard from '@/components/charts/PieChartCard';
import DataTable from '@/components/table/DataTable';
import { Radio, X, Shield, Search, Activity } from 'lucide-react';
import { queries as mskQ } from '@/lib/queries/msk';

interface PageData {
  [key: string]: { rows: Record<string, unknown>[]; error?: string };
}

export default function MSKPage() {
  const [data, setData] = useState<PageData>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchText, setSearchText] = useState('');

  const fetchData = useCallback(async (bustCache = false) => {
    setLoading(true);
    try {
      const res = await fetch(bustCache ? '/awsops/api/steampipe?bustCache=true' : '/awsops/api/steampipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: {
            summary: mskQ.summary,
            list: mskQ.list,
            stateDistribution: mskQ.stateDistribution,
            versionDistribution: mskQ.versionDistribution,
          },
        }),
      });
      setData(await res.json());
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fetchDetail = async (clusterName: string) => {
    setDetailLoading(true);
    try {
      const sql = mskQ.detail.replace(/{cluster_name}/g, clusterName);
      const res = await fetch('/awsops/api/steampipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: { detail: sql } }),
      });
      const result = await res.json();
      setSelected(result.detail?.rows?.[0] || null);
    } catch {} finally { setDetailLoading(false); }
  };

  const get = (key: string) => data[key]?.rows || [];
  const getFirst = (key: string) => get(key)[0] || {};
  const sum = getFirst('summary') as any;

  const safeJson = (raw: string | null | undefined): any => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };

  const clusters = get('list').filter((r: any) => {
    if (!searchText) return true;
    const s = searchText.toLowerCase();
    return (
      String(r.cluster_name || '').toLowerCase().includes(s) ||
      String(r.kafka_version || '').toLowerCase().includes(s) ||
      String(r.state || '').toLowerCase().includes(s) ||
      String(r.instance_type || '').toLowerCase().includes(s)
    );
  });

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <Header title="Amazon MSK" subtitle="Managed Streaming for Apache Kafka" onRefresh={() => fetchData(true)} />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatsCard label="Total Clusters" value={Number(sum?.total_clusters) || 0} icon={Radio} color="cyan"
          change={`${Number(sum?.active_clusters) || 0} active`} />
        <StatsCard label="Active" value={Number(sum?.active_clusters) || 0} icon={Activity} color="green"
          change={Number(sum?.inactive_clusters) > 0 ? `${sum.inactive_clusters} inactive` : 'All active'} />
        <StatsCard label="Total Brokers" value={Number(sum?.total_brokers) || 0} icon={Radio} color="purple"
          change="Across all clusters" />
        <StatsCard label="Enhanced Monitoring" value={Number(sum?.enhanced_monitoring) || 0} icon={Activity} color="orange"
          change={`of ${Number(sum?.total_clusters) || 0} clusters`} />
        <StatsCard label="In-Transit Encrypted" value={Number(sum?.encrypted_in_transit) || 0} icon={Shield}
          color={Number(sum?.encrypted_in_transit) === Number(sum?.total_clusters) ? 'green' : 'orange'}
          change={`of ${Number(sum?.total_clusters) || 0} clusters`} />
        <StatsCard label="Avg Brokers/Cluster" value={
          Number(sum?.total_clusters) > 0
            ? (Number(sum?.total_brokers) / Number(sum?.total_clusters)).toFixed(1)
            : '0'
        } icon={Radio} color="cyan" change="Per cluster" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PieChartCard title="Cluster State" data={get('stateDistribution').map((r: any) => ({ name: String(r.name), value: Number(r.value) }))} />
        <PieChartCard title="Kafka Version" data={get('versionDistribution').map((r: any) => ({ name: String(r.name), value: Number(r.value) }))} />
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input type="text" placeholder="Search clusters..."
          value={searchText} onChange={e => setSearchText(e.target.value)}
          className="w-full pl-9 pr-3 py-2 bg-navy-900 border border-navy-600 rounded-lg text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-accent-cyan/50" />
      </div>

      {/* Table */}
      <DataTable
        columns={[
          { key: 'cluster_name', label: 'Cluster Name', render: (v: any) => <span className="text-white font-medium">{v}</span> },
          { key: 'state', label: 'State', render: (v: any) => (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
              v === 'ACTIVE' ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-orange/10 text-accent-orange'
            }`}><span className={`w-1.5 h-1.5 rounded-full ${v === 'ACTIVE' ? 'bg-accent-green' : 'bg-accent-orange'}`} />{v}</span>
          )},
          { key: 'kafka_version', label: 'Kafka Version', render: (v: any) => <span className="font-mono text-xs">{v || '-'}</span> },
          { key: 'cluster_type', label: 'Type' },
          { key: 'instance_type', label: 'Instance', render: (v: any) => <span className="font-mono text-xs">{v || '-'}</span> },
          { key: 'number_of_broker_nodes', label: 'Brokers', render: (v: any) => <span className="font-mono">{v}</span> },
          { key: 'ebs_volume_gb', label: 'EBS (GB)', render: (v: any) => <span className="font-mono text-xs">{v || '-'}</span> },
          { key: 'enhanced_monitoring', label: 'Monitoring', render: (v: any) => (
            <span className={`text-xs ${v && v !== 'DEFAULT' ? 'text-accent-green' : 'text-gray-500'}`}>{v || '-'}</span>
          )},
          { key: 'creation_time', label: 'Created', render: (v: any) => v ? new Date(v).toLocaleDateString() : '-' },
        ]}
        data={loading ? undefined : clusters as any[]}
        onRowClick={(row: any) => fetchDetail(row.cluster_name)}
      />

      {/* Detail Panel */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="w-[520px] bg-navy-800 h-full overflow-y-auto border-l border-navy-600 p-6 space-y-5"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">MSK Cluster Detail</h2>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>

            {detailLoading ? (
              <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-4 bg-navy-700 rounded animate-pulse" />
              ))}</div>
            ) : (() => {
              const prov = safeJson(selected.provisioned);
              const broker = prov?.BrokerNodeGroupInfo;
              const enc = prov?.EncryptionInfo;
              const kafka = prov?.CurrentBrokerSoftwareInfo;
              const auth = prov?.ClientAuthentication;
              const logging = prov?.LoggingInfo;
              const monitoring = prov?.OpenMonitoring;

              return (
                <>
                  {/* Basic Info */}
                  <div className="bg-navy-900 rounded-lg p-4 space-y-2">
                    <h3 className="text-xs font-semibold text-accent-cyan uppercase tracking-wider mb-2">Cluster Info</h3>
                    {[
                      ['Cluster Name', selected.cluster_name],
                      ['State', selected.state],
                      ['Type', selected.cluster_type],
                      ['Kafka Version', kafka?.KafkaVersion],
                      ['Brokers', prov?.NumberOfBrokerNodes],
                      ['Enhanced Monitoring', prov?.EnhancedMonitoring],
                      ['Storage Mode', prov?.StorageMode],
                      ['Version', selected.current_version],
                      ['Created', selected.creation_time ? new Date(selected.creation_time).toLocaleString() : '-'],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between text-sm">
                        <span className="text-gray-500">{k}</span>
                        <span className="text-gray-200 font-mono text-xs">{String(v || '-')}</span>
                      </div>
                    ))}
                  </div>

                  {/* Broker Configuration */}
                  {broker && (
                    <div className="bg-navy-900 rounded-lg p-4 space-y-2">
                      <h3 className="text-xs font-semibold text-accent-cyan uppercase tracking-wider mb-2">Broker Configuration</h3>
                      {[
                        ['Instance Type', broker.InstanceType],
                        ['EBS Volume (GB)', broker.StorageInfo?.EbsStorageInfo?.VolumeSize],
                        ['AZ Distribution', broker.BrokerAZDistribution],
                        ['Zones', broker.ZoneIds?.join(', ')],
                        ['Public Access', broker.ConnectivityInfo?.PublicAccess?.Type],
                      ].map(([k, v]) => (
                        <div key={k} className="flex justify-between text-sm">
                          <span className="text-gray-500">{k}</span>
                          <span className="text-gray-200 font-mono text-xs">{String(v || '-')}</span>
                        </div>
                      ))}
                      <div className="mt-2">
                        <span className="text-gray-500 text-xs">Security Groups:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(broker.SecurityGroups || []).map((sg: string) => (
                            <span key={sg} className="px-2 py-0.5 bg-navy-700 rounded text-xs font-mono text-accent-cyan">{sg}</span>
                          ))}
                        </div>
                      </div>
                      <div className="mt-2">
                        <span className="text-gray-500 text-xs">Subnets:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(broker.ClientSubnets || []).map((sn: string) => (
                            <span key={sn} className="px-2 py-0.5 bg-navy-700 rounded text-xs font-mono text-gray-300">{sn}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Encryption */}
                  <div className={`rounded-lg p-4 border ${
                    enc?.EncryptionInTransit?.InCluster ? 'bg-accent-green/5 border-accent-green/30' : 'bg-accent-orange/5 border-accent-orange/30'
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      <Shield size={16} className={enc?.EncryptionInTransit?.InCluster ? 'text-accent-green' : 'text-accent-orange'} />
                      <h3 className="text-sm font-semibold text-white">Encryption</h3>
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-gray-400">In-Transit (InCluster)</span>
                        <span className={enc?.EncryptionInTransit?.InCluster ? 'text-accent-green' : 'text-accent-red'}>
                          {enc?.EncryptionInTransit?.InCluster ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Client-Broker</span>
                        <span className="text-gray-300 font-mono">{enc?.EncryptionInTransit?.ClientBroker || '-'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">At-Rest KMS Key</span>
                        <span className="text-gray-300 font-mono text-[10px] max-w-[280px] truncate block">
                          {enc?.EncryptionAtRest?.DataVolumeKMSKeyId || 'AWS managed'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Authentication */}
                  {auth && (
                    <div className="bg-navy-900 rounded-lg p-4 space-y-2">
                      <h3 className="text-xs font-semibold text-accent-cyan uppercase tracking-wider mb-2">Authentication</h3>
                      {[
                        ['Unauthenticated', auth.Unauthenticated?.Enabled ? 'Enabled' : 'Disabled'],
                        ['SASL/IAM', auth.Sasl?.Iam?.Enabled ? 'Enabled' : 'Disabled'],
                        ['SASL/SCRAM', auth.Sasl?.Scram?.Enabled ? 'Enabled' : 'Disabled'],
                        ['TLS', auth.Tls ? 'Configured' : 'Not configured'],
                      ].map(([k, v]) => (
                        <div key={k} className="flex justify-between text-sm">
                          <span className="text-gray-500">{k}</span>
                          <span className={`text-xs ${v === 'Enabled' || v === 'Configured' ? 'text-accent-green' : 'text-gray-500'}`}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Bootstrap Brokers */}
                  {(selected.bootstrap_broker_string || selected.bootstrap_broker_string_tls) && (
                    <div className="bg-navy-900 rounded-lg p-4">
                      <h3 className="text-xs font-semibold text-accent-cyan uppercase tracking-wider mb-2">Bootstrap Brokers</h3>
                      {selected.bootstrap_broker_string && (
                        <div className="mb-2">
                          <span className="text-gray-500 text-xs">Plaintext:</span>
                          <p className="text-xs text-gray-400 font-mono break-all mt-0.5">{selected.bootstrap_broker_string}</p>
                        </div>
                      )}
                      {selected.bootstrap_broker_string_tls && (
                        <div>
                          <span className="text-gray-500 text-xs">TLS:</span>
                          <p className="text-xs text-gray-400 font-mono break-all mt-0.5">{selected.bootstrap_broker_string_tls}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Monitoring */}
                  {monitoring && (
                    <div className="bg-navy-900 rounded-lg p-4 space-y-2">
                      <h3 className="text-xs font-semibold text-accent-cyan uppercase tracking-wider mb-2">Open Monitoring</h3>
                      {[
                        ['JMX Exporter', monitoring.Prometheus?.JmxExporter?.EnabledInBroker ? 'Enabled' : 'Disabled'],
                        ['Node Exporter', monitoring.Prometheus?.NodeExporter?.EnabledInBroker ? 'Enabled' : 'Disabled'],
                      ].map(([k, v]) => (
                        <div key={k} className="flex justify-between text-sm">
                          <span className="text-gray-500">{k}</span>
                          <span className={`text-xs ${v === 'Enabled' ? 'text-accent-green' : 'text-gray-500'}`}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Logging */}
                  {logging && (
                    <div className="bg-navy-900 rounded-lg p-4 space-y-2">
                      <h3 className="text-xs font-semibold text-accent-cyan uppercase tracking-wider mb-2">Logging</h3>
                      {[
                        ['CloudWatch Logs', logging.BrokerLogs?.CloudWatchLogs?.Enabled ? `Enabled → ${logging.BrokerLogs.CloudWatchLogs.LogGroup}` : 'Disabled'],
                        ['S3 Logs', logging.BrokerLogs?.S3?.Enabled ? `Enabled → ${logging.BrokerLogs.S3.Bucket}` : 'Disabled'],
                        ['Firehose', logging.BrokerLogs?.Firehose?.Enabled ? 'Enabled' : 'Disabled'],
                      ].map(([k, v]) => (
                        <div key={k} className="flex justify-between text-sm">
                          <span className="text-gray-500">{k}</span>
                          <span className="text-gray-300 text-xs max-w-[280px] truncate">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
