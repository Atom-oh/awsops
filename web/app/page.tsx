'use client';
import { useCallback, useEffect, useState } from 'react';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import SectionLabel from '@/components/ui/SectionLabel';
import Card from '@/components/ui/Card';
import BarDistribution from '@/components/charts/BarDistribution';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import AreaTrend from '@/components/charts/AreaTrend';
import AiOps from '@/components/overview/AiOps';

interface Overview {
  jobs: { queued: number; running: number; succeeded: number; failed: number };
  clusterCount: number | null;
  mtdCost: number | null;
}
interface ByType { type: string; label: string; count: number; [k: string]: unknown }
interface ByCategory { group: string; count: number; [k: string]: unknown }
interface Splits {
  ec2Running: number;
  ec2Stopped: number;
  ebsUnencrypted: number;
  iamUserNoMfa: number;
  sgOpenIngress: number;
  s3Public: number;
}
interface Ec2Type { name: string; count: number; [k: string]: unknown }
interface Summary { byType: ByType[]; byCategory: ByCategory[]; total: number; splits?: Splits; ec2Types?: Ec2Type[] }
interface TrendPoint { date: string; amount: number; [k: string]: unknown }
interface Cost { trend: TrendPoint[] }
interface JobSlice { name: string; value: number; [k: string]: unknown }
interface FleetCluster {
  name: string;
  reachable: boolean;
  counts: { nodes: number; nodesReady: number; pods: number; podsRunning: number; deployments: number; services: number };
  podStatus: Record<string, number>;
  events: { reason?: string; message?: string; object?: string; count?: number; lastSeenTs?: number; [k: string]: unknown }[];
}
interface Fleet { clusters: FleetCluster[] }

const DASH = '—';
// Section gateways per ADR-004 (8). Named so the AgentCore tile isn't a bare magic literal.
const SECTION_GATEWAYS = 8;

export default function Home() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState('');
  const [sum, setSum] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState('');
  const [cost, setCost] = useState<Cost | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setBusy(true);
    // Core summaries (Aurora-backed, fast) gate the refresh spinner. Each degrades on its
    // own (allSettled) so one failure never blanks the others.
    await Promise.allSettled([
      fetch('/api/overview')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => { setOv(d); setOvErr(''); })
        .catch((e) => setOvErr(String(e))),
      fetch('/api/inventory/summary')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => { setSum(d); setSumErr(''); })
        .catch((e) => setSumErr(String(e))),
      fetch('/api/cost')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(setCost)
        .catch(() => setCost({ trend: [] })),
    ]);
    setCapturedAt(new Date().toISOString());
    setBusy(false);

    // EKS fleet is a LIVE K8s read (nodes/pods/events per cluster). Kept OUT of the
    // busy-gated set so it never blocks the spinner, and bounded on BOTH ends: the client
    // AbortController (6s) drops the request here, while the server-side k8sGet timeout
    // (K8S_REQUEST_TIMEOUT_MS in eks-incluster) closes the actual K8s socket so a slow/stuck
    // API can't occupy the web task (thin-BFF). The charts fill in on resolve, else stay empty.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    fetch('/api/eks/fleet', { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setFleet)
      .catch(() => setFleet({ clusters: [] }))
      .finally(() => clearTimeout(t));
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // type → count lookup from the inventory summary (DASH when summary unavailable).
  const n = (type: string): number | string => {
    if (!sum) return DASH;
    return sum.byType.find((t) => t.type === type)?.count ?? 0;
  };

  const jobs = ov?.jobs;
  const jobsDonut: JobSlice[] | undefined =
    jobs &&
    [
      { name: '성공', value: jobs.succeeded },
      { name: '실패', value: jobs.failed },
      { name: '실행', value: jobs.running },
      { name: '대기', value: jobs.queued },
    ].filter((d) => d.value > 0);

  const barData = sum ? sum.byType.filter((t) => t.count > 0).slice(0, 12) : [];
  const trend = cost?.trend ?? [];
  const ec2Types = (sum?.ec2Types ?? []).filter((t) => t.count > 0);

  // Aggregate the EKS fleet across clusters (counts, pod phases, recent events).
  const clusters = fleet?.clusters ?? [];
  const eks = clusters.reduce(
    (a, c) => {
      a.nodes += c.counts?.nodes ?? 0;
      a.pods += c.counts?.pods ?? 0;
      a.deployments += c.counts?.deployments ?? 0;
      for (const [k, v] of Object.entries(c.podStatus ?? {})) a.podStatus[k] = (a.podStatus[k] ?? 0) + Number(v);
      return a;
    },
    { nodes: 0, pods: 0, deployments: 0, podStatus: {} as Record<string, number> },
  );
  const podStatusDonut = Object.entries(eks.podStatus)
    .map(([name, value]) => ({ name, value }))
    .filter((d) => d.value > 0);
  const recentEvents = clusters
    .flatMap((c) => (c.events ?? []).map((e) => ({ ...e, cluster: c.name })))
    .sort((a, b) => (Number(b.lastSeenTs) || 0) - (Number(a.lastSeenTs) || 0))
    .slice(0, 8);
  const hasFleet = clusters.length > 0;

  // Security-issue rollup across the four /security findings (public S3 + open ingress +
  // unencrypted EBS + IAM without MFA). The public-S3 count is produced by the summary
  // route using the SAME shared PUBLIC_S3_WHERE predicate as the /security page, so this
  // home tile stays consistent with /security (incl. Block-Public-Access-off buckets).
  const sp = sum?.splits;
  const secIssues = sp ? sp.sgOpenIngress + sp.ebsUnencrypted + sp.iamUserNoMfa + sp.s3Public : null;

  // Cost daily average (MTD ÷ elapsed days) for the cost tile subline.
  const dailyAvg =
    ov && ov.mtdCost != null ? ov.mtdCost / Math.max(1, new Date().getDate()) : null;

  const loading = !ov && !ovErr && !sum && !sumErr;

  return (
    <>
      <PageHeader
        title="대시보드"
        subtitle="실시간 AWS · Kubernetes 운영 현황"
        right={<RefreshButton busy={busy} onClick={loadAll} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {loading && <div className="text-ink-400">로딩 중…</div>}
        {ovErr && (
          <div className="text-[13px] text-rose-600">
            운영 요약 로드 실패: {ovErr} (세션 만료면 새로고침)
          </div>
        )}

        {/* ---- AI OPERATIONS (v1-parity: chat + analysis entry points) ---- */}
        <AiOps />

        {/* ---- KPI group 1: COMPUTE & CONTAINERS ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel>COMPUTE &amp; CONTAINERS</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatTile
              label="EC2 인스턴스"
              value={n('ec2')}
              variant="accent"
              href="/inventory/ec2"
              hint={sum?.splits ? `${sum.splits.ec2Running} running · ${sum.splits.ec2Stopped} stopped` : undefined}
            />
            <StatTile label="Lambda 함수" value={n('lambda')} href="/inventory/lambda" />
            <StatTile label="ECS 클러스터" value={n('ecs_cluster')} href="/inventory/ecs_cluster" />
            <StatTile label="AgentCore" value={`${SECTION_GATEWAYS} GW`} href="/assistant" hint="섹션 게이트웨이 · 어시스턴트" />
            <StatTile label="ECR 리포지토리" value={n('ecr')} href="/inventory/ecr" />
            <StatTile
              label="EKS 클러스터"
              value={ov ? ov.clusterCount ?? DASH : DASH}
              href="/eks"
              hint={hasFleet ? `노드 ${eks.nodes} · 파드 ${eks.pods} · 배포 ${eks.deployments}` : undefined}
            />
            <StatTile label="CloudFront" value={n('cloudfront')} href="/inventory/cloudfront" />
          </div>
        </section>

        {/* ---- KPI group 2: STORAGE & NETWORK ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel>STORAGE &amp; NETWORK</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatTile label="VPC" value={n('vpc')} href="/inventory/vpc" />
            <StatTile label="WAF" value={n('waf')} href="/inventory/waf" />
            <StatTile
              label="EBS 볼륨"
              value={n('ebs_volume')}
              href="/inventory/ebs_volume"
              hint={sum?.splits ? (sum.splits.ebsUnencrypted > 0 ? `미암호화 ${sum.splits.ebsUnencrypted}` : '전체 암호화') : undefined}
              variant={sum?.splits && sum.splits.ebsUnencrypted > 0 ? 'warn' : 'default'}
            />
            <StatTile label="S3 버킷" value={n('s3')} href="/inventory/s3" />
            <StatTile label="RDS 인스턴스" value={n('rds')} href="/inventory/rds" />
            <StatTile label="DynamoDB 테이블" value={n('dynamodb')} href="/inventory/dynamodb" />
            <StatTile label="ElastiCache" value={n('elasticache')} href="/inventory/elasticache" />
            <StatTile label="OpenSearch" value={n('opensearch')} href="/inventory/opensearch" />
            <StatTile label="MSK" value={n('msk')} href="/inventory/msk" />
          </div>
        </section>

        {/* ---- KPI group 3: SECURITY · OPS · COST ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel>SECURITY · OPS · COST</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatTile
              label="보안 이슈"
              value={secIssues == null ? DASH : secIssues}
              href="/security"
              variant={secIssues && secIssues > 0 ? 'danger' : 'default'}
              hint={secIssues != null ? (secIssues > 0 ? '공개 S3 · 개방 SG · 미암호화 · MFA 미설정' : '✓ 이상 없음') : undefined}
            />
            <StatTile label="IAM 역할" value={n('iam_role')} href="/inventory/iam_role" />
            <StatTile
              label="IAM 사용자"
              value={n('iam_user')}
              href="/inventory/iam_user"
              hint={sum?.splits ? (sum.splits.iamUserNoMfa > 0 ? `MFA 미설정 ${sum.splits.iamUserNoMfa}` : 'MFA 전체 설정') : undefined}
              variant={sum?.splits && sum.splits.iamUserNoMfa > 0 ? 'warn' : 'default'}
            />
            <StatTile
              label="보안 그룹"
              value={n('security_group')}
              href="/inventory/security_group"
              hint={sum?.splits ? `인그레스 개방 ${sum.splits.sgOpenIngress}` : undefined}
              variant={sum?.splits && sum.splits.sgOpenIngress > 0 ? 'warn' : 'default'}
            />
            <StatTile label="CloudWatch 알람" value={n('cloudwatch_alarm')} href="/inventory/cloudwatch_alarm" />
            <StatTile label="CloudTrail" value={n('cloudtrail')} href="/inventory/cloudtrail" />
            <StatTile label="CIS 컴플라이언스" value={DASH} href="/compliance" hint="벤치마크 실행 →" />
            <StatTile
              label="작업 (성공/실패)"
              value={jobs ? `${jobs.succeeded} / ${jobs.failed}` : DASH}
              href="/jobs"
              variant={jobs && jobs.failed > 0 ? 'danger' : 'default'}
              hint={jobs ? `${jobs.queued + jobs.running} 대기·실행 중` : undefined}
            />
            <StatTile
              label="이번 달 비용 (USD)"
              value={ov ? (ov.mtdCost == null ? DASH : `$${ov.mtdCost.toFixed(2)}`) : DASH}
              href="/cost"
              variant="accent"
              hint={dailyAvg != null ? `약 $${dailyAvg.toFixed(2)}/일` : undefined}
            />
          </div>
        </section>

        {/* ---- Charts row 1: distribution bar (wide) + category donut ---- */}
        {sumErr ? (
          <div className="text-[13px] text-ink-400">
            리소스 분포 데이터를 불러오지 못했습니다: {sumErr}
          </div>
        ) : sum ? (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-6">
              <BarDistribution title="리소스 분포" data={barData} xKey="label" yKey="count" />
              <DonutBreakdown
                title="카테고리별 리소스"
                data={sum.byCategory}
                nameKey="group"
                valueKey="count"
              />
            </div>

            {/* ---- Charts row 2: resource-distribution donuts (EC2 type · K8s pods · jobs) ---- */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {ec2Types.length > 0 ? (
                <DonutBreakdown title="EC2 인스턴스 유형" data={ec2Types} nameKey="name" valueKey="count" />
              ) : (
                <Card title="EC2 인스턴스 유형">
                  <div className="text-[13px] text-ink-400">EC2 데이터 없음</div>
                </Card>
              )}
              {podStatusDonut.length > 0 ? (
                <DonutBreakdown title="K8s 파드 상태" data={podStatusDonut} nameKey="name" valueKey="value" />
              ) : (
                <Card title="K8s 파드 상태">
                  <div className="text-[13px] text-ink-400">{hasFleet ? '파드 없음' : 'EKS 데이터 없음'}</div>
                </Card>
              )}
              {jobsDonut && jobsDonut.length > 0 ? (
                <DonutBreakdown title="작업 상태" data={jobsDonut} nameKey="name" valueKey="value" />
              ) : (
                <Card title="작업 상태">
                  <div className="text-[13px] text-ink-400">작업 데이터 없음</div>
                </Card>
              )}
            </div>

            {/* ---- Charts row 3: cost trend (wide) + recent K8s events ---- */}
            <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-6">
              {trend.length > 0 ? (
                <AreaTrend
                  title="일별 비용 추이"
                  data={trend}
                  xKey="date"
                  yKey="amount"
                  valuePrefix="$"
                />
              ) : (
                <Card title="일별 비용 추이">
                  <div className="text-[13px] text-ink-400">비용 데이터 없음</div>
                </Card>
              )}
              <Card title="최근 K8s 이벤트">
                {recentEvents.length > 0 ? (
                  <ul className="flex flex-col divide-y divide-ink-100">
                    {recentEvents.map((e, i) => (
                      <li key={i} className="py-2 first:pt-0 last:pb-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            {String(e.reason ?? 'Event')}
                          </span>
                          <span className="truncate font-mono text-[11px] text-ink-500">{String(e.object ?? '')}</span>
                          {Number(e.count) > 1 && <span className="text-[10px] text-ink-400">×{Number(e.count)}</span>}
                          <span className="ml-auto shrink-0 text-[10px] text-ink-300">{String(e.cluster ?? '')}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 break-words text-[12px] text-ink-700">{String(e.message ?? '')}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[13px] text-ink-400">{hasFleet ? '최근 이벤트 없음' : 'EKS 데이터 없음'}</div>
                )}
              </Card>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
