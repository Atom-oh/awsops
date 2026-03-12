'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Filter } from 'lucide-react';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/dashboard/StatsCard';
import StatusBadge from '@/components/dashboard/StatusBadge';
import PieChartCard from '@/components/charts/PieChartCard';
import BarChartCard from '@/components/charts/BarChartCard';
import DataTable from '@/components/table/DataTable';
import { Box, Rocket, Network, Server, AlertTriangle } from 'lucide-react';
import { queries as k8sQ } from '@/lib/queries/k8s';

// Format K8s memory values (e.g. "32986188Ki" → "31.5 GiB") / K8s 메모리 가독성 변환
function formatK8sMemory(mem: any): string {
  if (!mem) return '--';
  const s = String(mem);
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T|k|m|g|t)?$/);
  if (!match) return s;
  let value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'ki' || unit === 'k') value = value / 1024;
  else if (unit === 'gi' || unit === 'g') value = value * 1024;
  else if (unit === 'ti' || unit === 't') value = value * 1024 * 1024;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} TiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GiB`;
  if (value >= 1) return `${Math.round(value)} MiB`;
  return `${Math.round(value * 1024)} KiB`;
}

interface DashboardData {
  [key: string]: { rows: Record<string, unknown>[]; error?: string };
}

const NODE_LIST_QUERY = `
  SELECT
    name, uid, pod_cidr, capacity_cpu, capacity_memory,
    allocatable_cpu, allocatable_memory,
    CASE WHEN jsonb_array_length(conditions) > 0 THEN 'Ready' ELSE 'NotReady' END as status
  FROM kubernetes_node
`;

const POD_REQUESTS_QUERY = `
  SELECT
    p.node_name,
    c->'resources'->'requests'->>'cpu' AS cpu_req,
    c->'resources'->'requests'->>'memory' AS mem_req
  FROM
    kubernetes_pod p,
    jsonb_array_elements(p.containers) AS c
  WHERE
    p.phase = 'Running' AND p.node_name IS NOT NULL
`;

// Parse K8s CPU (e.g. "8" → 8, "7910m" → 7.91) / K8s CPU 파싱
function parseCpu(cpu: any): number {
  if (!cpu) return 0;
  const s = String(cpu).trim();
  if (s.endsWith('m')) return parseFloat(s) / 1000;
  return parseFloat(s) || 0;
}

// Parse K8s memory to MiB / K8s 메모리 MiB 변환
function parseMiB(mem: any): number {
  if (!mem) return 0;
  const s = String(mem);
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti)?$/i);
  if (!match) return parseInt(s) || 0;
  let v = parseFloat(match[1]);
  const u = (match[2] || '').toLowerCase();
  if (u === 'ki') v = v / 1024;
  else if (u === 'gi') v = v * 1024;
  else if (u === 'ti') v = v * 1024 * 1024;
  return Math.round(v);
}

export default function K8sOverviewPage() {
  const [data, setData] = useState<DashboardData>({});
  const [loading, setLoading] = useState(true);
  const [selectedClusters, setSelectedClusters] = useState<Set<string>>(new Set());
  const [selectedVpcs, setSelectedVpcs] = useState<Set<string>>(new Set());
  const [showFilter, setShowFilter] = useState(false);

  const fetchData = useCallback(async (bustCache = false) => {
    setLoading(true);
    try {
      const res = await fetch(bustCache ? '/awsops/api/steampipe?bustCache=true' : '/awsops/api/steampipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: {
            nodeSummary: k8sQ.nodeSummary,
            podSummary: k8sQ.podSummary,
            deploymentSummary: k8sQ.deploymentSummary,
            serviceList: k8sQ.serviceList,
            warningEvents: k8sQ.warningEvents,
            namespaceSummary: k8sQ.namespaceSummary,
            nodeList: NODE_LIST_QUERY,
            podRequests: POD_REQUESTS_QUERY,
            eksClusters: k8sQ.eksClusterList,
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

  const nodeSummary = getFirst('nodeSummary') as any;
  const podSummary = getFirst('podSummary') as any;
  const deploySummary = getFirst('deploymentSummary') as any;
  const services = get('serviceList');
  const events = get('warningEvents');
  const namespaces = get('namespaceSummary');
  const nodes = get('nodeList');
  const podReqRows = get('podRequests');
  const eksClusters = get('eksClusters');

  // Aggregate pod requests per node / 노드별 Pod 리소스 요청 집계
  const reqMap: Record<string, { cpuReq: number; memReqMiB: number; podCount: number }> = {};
  podReqRows.forEach((r: any) => {
    const node = String(r.node_name || '');
    if (!node) return;
    if (!reqMap[node]) reqMap[node] = { cpuReq: 0, memReqMiB: 0, podCount: 0 };
    reqMap[node].podCount += 1;
    if (r.cpu_req) reqMap[node].cpuReq += parseCpu(r.cpu_req);
    if (r.mem_req) reqMap[node].memReqMiB += parseMiB(r.mem_req);
  });

  // Extract unique clusters and VPCs / 클러스터 및 VPC 목록 추출
  const clusterNames = useMemo(() => eksClusters.map((c: any) => String(c.cluster_name)).sort(), [eksClusters]);
  const vpcList = useMemo(() => {
    const vpcs = new Set<string>();
    eksClusters.forEach((c: any) => { if (c.vpc_id) vpcs.add(String(c.vpc_id)); });
    return Array.from(vpcs).sort();
  }, [eksClusters]);

  // Filter clusters / 클러스터 필터링
  const filteredClusters = useMemo(() => {
    if (selectedClusters.size === 0 && selectedVpcs.size === 0) return eksClusters;
    return eksClusters.filter((c: any) => {
      const matchCluster = selectedClusters.size === 0 || selectedClusters.has(String(c.cluster_name));
      const matchVpc = selectedVpcs.size === 0 || selectedVpcs.has(String(c.vpc_id));
      return matchCluster && matchVpc;
    });
  }, [eksClusters, selectedClusters, selectedVpcs]);

  const hasFilters = selectedClusters.size > 0 || selectedVpcs.size > 0;

  // Toggle helpers / 토글 헬퍼
  const toggleCluster = (name: string) => {
    setSelectedClusters(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };
  const toggleVpc = (vpc: string) => {
    setSelectedVpcs(prev => {
      const next = new Set(prev);
      if (next.has(vpc)) next.delete(vpc); else next.add(vpc);
      return next;
    });
  };
  const clearFilters = () => { setSelectedClusters(new Set()); setSelectedVpcs(new Set()); };

  // Pod status pie data
  const podStatusData = [
    { name: 'Running', value: Number(podSummary.running_pods) || 0 },
    { name: 'Pending', value: Number(podSummary.pending_pods) || 0 },
    { name: 'Failed', value: Number(podSummary.failed_pods) || 0 },
    { name: 'Succeeded', value: Number(podSummary.succeeded_pods) || 0 },
  ].filter((d) => d.value > 0);

  // Namespace bar data
  const namespaceData = namespaces.map((ns: any) => ({
    name: ns.name,
    value: 1,
  }));

  return (
    <div className="min-h-screen">
      <Header
        title="Kubernetes Overview"
        subtitle="Cluster health and resource summary"
        onRefresh={() => fetchData(true)}
      />

      <main className="p-6 space-y-6">
        {/* EKS Cluster / VPC Filter / EKS 클러스터 및 VPC 필터 */}
        {eksClusters.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowFilter(!showFilter)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  showFilter || hasFilters
                    ? 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30'
                    : 'bg-navy-800 text-gray-400 border border-navy-600 hover:text-white'
                }`}
              >
                <Filter size={14} />
                Cluster / VPC Filter
                {hasFilters && (
                  <span className="bg-accent-cyan/20 text-accent-cyan text-xs px-1.5 py-0.5 rounded-full">
                    {selectedClusters.size + selectedVpcs.size}
                  </span>
                )}
              </button>
              {hasFilters && (
                <button onClick={clearFilters} className="text-xs text-gray-500 hover:text-white transition-colors">
                  Clear all
                </button>
              )}
              <span className="text-xs text-gray-500 ml-auto">
                {filteredClusters.length} / {eksClusters.length} clusters
              </span>
            </div>

            {showFilter && (
              <div className="bg-navy-800 border border-navy-600 rounded-lg p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Cluster select / 클러스터 선택 */}
                <div>
                  <p className="text-xs font-mono uppercase text-gray-400 tracking-wider mb-2">EKS Clusters</p>
                  <div className="flex flex-wrap gap-2">
                    {clusterNames.map((name: string) => (
                      <button
                        key={name}
                        onClick={() => toggleCluster(name)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                          selectedClusters.has(name)
                            ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40'
                            : 'bg-navy-900 text-gray-400 border border-navy-700 hover:text-white hover:border-navy-500'
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                {/* VPC select / VPC 선택 */}
                <div>
                  <p className="text-xs font-mono uppercase text-gray-400 tracking-wider mb-2">VPCs</p>
                  <div className="flex flex-wrap gap-2">
                    {vpcList.map((vpc: string) => {
                      const clusterCount = eksClusters.filter((c: any) => String(c.vpc_id) === vpc).length;
                      return (
                        <button
                          key={vpc}
                          onClick={() => toggleVpc(vpc)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                            selectedVpcs.has(vpc)
                              ? 'bg-accent-purple/20 text-accent-purple border border-accent-purple/40'
                              : 'bg-navy-900 text-gray-400 border border-navy-700 hover:text-white hover:border-navy-500'
                          }`}
                        >
                          {vpc} <span className="text-gray-600">({clusterCount})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* EKS Cluster Cards / EKS 클러스터 카드 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredClusters.map((c: any) => (
                <div key={c.cluster_name} className="bg-navy-800 border border-navy-600 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-mono text-sm font-semibold">{c.cluster_name}</span>
                    <StatusBadge status={c.status || 'UNKNOWN'} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-gray-500">Version: </span><span className="text-gray-300 font-mono">{c.version}</span></div>
                    <div><span className="text-gray-500">VPC: </span><span className="text-accent-purple font-mono">{c.vpc_id}</span></div>
                    <div><span className="text-gray-500">Platform: </span><span className="text-gray-300 font-mono">{c.platform_version || '--'}</span></div>
                    <div><span className="text-gray-500">Region: </span><span className="text-gray-300 font-mono">{c.region}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stats Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard
            label="Nodes"
            value={nodeSummary.total_nodes ?? '-'}
            icon={Server}
            color="cyan"
            change={`${nodeSummary.ready_nodes ?? 0} ready`}
          />
          <StatsCard
            label="Pods"
            value={podSummary.total_pods ?? '-'}
            icon={Box}
            color="green"
            change={`${podSummary.running_pods ?? 0} running`}
          />
          <StatsCard
            label="Deployments"
            value={deploySummary.total_deployments ?? '-'}
            icon={Rocket}
            color="purple"
            change={`${deploySummary.fully_available ?? 0} fully available`}
          />
          <StatsCard
            label="Services"
            value={services.length}
            icon={Network}
            color="orange"
          />
        </div>

        {/* Node Cards Grid */}
        <div>
          <h2 className="text-lg font-semibold text-white mb-3">Nodes</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {nodes.map((node: any) => {
              const capCpu = parseCpu(node.capacity_cpu) || 1;
              const capMiB = parseMiB(node.capacity_memory) || 1;
              const req = reqMap[node.name] || { cpuReq: 0, memReqMiB: 0, podCount: 0 };
              const cpuPct = Math.min(Math.round((req.cpuReq / capCpu) * 100), 100);
              const memPct = Math.min(Math.round((req.memReqMiB / capMiB) * 100), 100);
              return (
                <div
                  key={node.name}
                  className="bg-navy-800 border border-navy-600 rounded-lg p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Server size={16} className="text-accent-cyan" />
                      <span className="text-white font-mono text-sm">{node.name.split('.')[0]}</span>
                    </div>
                    <StatusBadge status={node.status ?? 'Unknown'} />
                  </div>

                  {/* CPU Usage Bar / CPU 사용량 바 */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-gray-500">CPU</span>
                      <span className="text-white font-mono">{req.cpuReq.toFixed(1)} / {capCpu} vCPU <span className={cpuPct >= 80 ? 'text-accent-red' : cpuPct >= 50 ? 'text-accent-orange' : 'text-accent-cyan'}>({cpuPct}%)</span></span>
                    </div>
                    <div className="h-3 bg-navy-900 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${cpuPct >= 80 ? 'bg-accent-red' : cpuPct >= 50 ? 'bg-accent-orange' : 'bg-accent-cyan'}`} style={{ width: `${cpuPct}%` }} />
                    </div>
                  </div>

                  {/* Memory Usage Bar / 메모리 사용량 바 */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-gray-500">Memory</span>
                      <span className="text-white font-mono">{formatK8sMemory(`${req.memReqMiB}Mi`)} / {formatK8sMemory(node.capacity_memory)} <span className={memPct >= 80 ? 'text-accent-red' : memPct >= 50 ? 'text-accent-orange' : 'text-accent-purple'}>({memPct}%)</span></span>
                    </div>
                    <div className="h-3 bg-navy-900 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${memPct >= 80 ? 'bg-accent-red' : memPct >= 50 ? 'bg-accent-orange' : 'bg-accent-purple'}`} style={{ width: `${memPct}%` }} />
                    </div>
                  </div>

                  <div className="text-[10px] text-gray-500">
                    {req.podCount} pods {node.pod_cidr && `· CIDR ${node.pod_cidr}`}
                  </div>
                </div>
              );
            })}
            {nodes.length === 0 && !loading && (
              <div className="col-span-full text-center text-gray-500 py-8">No nodes found</div>
            )}
          </div>
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PieChartCard title="Pod Status Distribution" data={podStatusData} />
          <BarChartCard title="Namespaces" data={namespaceData} color="#00d4ff" />
        </div>

        {/* Warning Events Table */}
        <div>
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <AlertTriangle size={18} className="text-accent-orange" />
            Warning Events
          </h2>
          <DataTable
            columns={[
              { key: 'involved_object_kind', label: 'Kind' },
              { key: 'involved_object_name', label: 'Object' },
              { key: 'reason', label: 'Reason' },
              { key: 'message', label: 'Message' },
              { key: 'count', label: 'Count' },
              { key: 'last_timestamp', label: 'Last Seen' },
            ]}
            data={events}
          />
        </div>
      </main>
    </div>
  );
}
