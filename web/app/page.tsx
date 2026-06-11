'use client';
import { useEffect, useState } from 'react';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
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
interface Summary { byType: ByType[]; byCategory: ByCategory[]; total: number }
interface TrendPoint { date: string; amount: number; [k: string]: unknown }
interface Cost { trend: TrendPoint[] }
interface JobSlice { name: string; value: number; [k: string]: unknown }

const DASH = '—';

export default function Home() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState('');
  const [sum, setSum] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState('');
  const [cost, setCost] = useState<Cost | null>(null);

  useEffect(() => {
    // Three independent fetches — each degrades on its own.
    fetch('/api/overview')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setOv)
      .catch((e) => setOvErr(String(e)));
    fetch('/api/inventory/summary')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setSum)
      .catch((e) => setSumErr(String(e)));
    fetch('/api/cost')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setCost)
      .catch(() => setCost({ trend: [] }));
  }, []);

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

  const loading = !ov && !ovErr && !sum && !sumErr;

  return (
    <>
      <PageHeader title="대시보드" live subtitle="실시간 AWS · Kubernetes 운영 현황" />
      <div className="px-8 py-8 flex flex-col gap-6">
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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatTile label="EC2 인스턴스" value={n('ec2')} variant="accent" />
            <StatTile label="Lambda 함수" value={n('lambda')} />
            <StatTile label="ECS 클러스터" value={n('ecs_cluster')} />
            <StatTile label="ECR 리포지토리" value={n('ecr')} />
            <StatTile label="EKS 클러스터" value={ov ? ov.clusterCount ?? DASH : DASH} />
          </div>
        </section>

        {/* ---- KPI group 2: STORAGE & NETWORK ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel>STORAGE &amp; NETWORK</SectionLabel>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatTile label="S3 버킷" value={n('s3')} />
            <StatTile label="EBS 볼륨" value={n('ebs_volume')} />
            <StatTile label="RDS 인스턴스" value={n('rds')} />
            <StatTile label="DynamoDB 테이블" value={n('dynamodb')} />
            <StatTile label="VPC" value={n('vpc')} />
          </div>
        </section>

        {/* ---- KPI group 3: SECURITY · OPS · COST ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel>SECURITY · OPS · COST</SectionLabel>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatTile label="IAM 역할" value={n('iam_role')} />
            <StatTile label="보안 그룹" value={n('security_group')} />
            <StatTile
              label="작업 (성공/실패)"
              value={jobs ? `${jobs.succeeded} / ${jobs.failed}` : DASH}
              variant={jobs && jobs.failed > 0 ? 'danger' : 'default'}
              hint={jobs ? `${jobs.queued + jobs.running} 대기·실행 중` : undefined}
            />
            <StatTile label="CloudWatch 알람" value={n('cloudwatch_alarm')} />
            <StatTile
              label="이번 달 비용 (USD)"
              value={ov ? (ov.mtdCost == null ? DASH : `$${ov.mtdCost.toFixed(2)}`) : DASH}
              variant="accent"
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
            {/* ---- Charts row 2: jobs donut + cost trend area ---- */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.6fr] gap-6">
              {jobsDonut && jobsDonut.length > 0 ? (
                <DonutBreakdown title="작업 상태" data={jobsDonut} nameKey="name" valueKey="value" />
              ) : (
                <Card title="작업 상태">
                  <div className="text-[13px] text-ink-400">작업 데이터 없음</div>
                </Card>
              )}
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
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
