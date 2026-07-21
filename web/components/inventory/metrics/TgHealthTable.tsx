'use client';
import { TH, TD, MONO, DANGER, dash } from './shared';

// 타깃 그룹 헬스 테이블 (ALB/NLB 공용) — Healthy/UnHealthyHostCount는 TG 차원이어야 의미.
// Healthy = 1h 최소값(순간 이탈 감지), UnHealthy = 1h 최대값.
export interface TgHealthRow { tg: string; tgName: string; lbDim: string; healthy: number | null; unhealthy: number | null }

export default function TgHealthTable({ health, lbDims }: { health: TgHealthRow[]; lbDims: Record<string, string> }) {
  if (health.length === 0) return null;
  return (
    <div className="border-t border-ink-100">
      <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">타깃 그룹 헬스 (Healthy 최소값 / UnHealthy 최대값, Last 1h)</div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Target Group', 'Load Balancer', 'Healthy (min)', 'UnHealthy (max)'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {health.map((hRow, i) => {
              const lbName = Object.entries(lbDims).find(([, d]) => d === hRow.lbDim)?.[0] ?? hRow.lbDim;
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{hRow.tgName}</td>
                  <td className={MONO}>{lbName}</td>
                  <td className={`${TD} ${hRow.healthy != null && hRow.healthy <= 0 ? DANGER : ''}`} title="HealthyHostCount — 0이면 가용 타깃 없음 (ALB는 503 발생)">
                    {hRow.healthy == null ? dash : Math.round(hRow.healthy)}
                  </td>
                  <td className={`${TD} ${hRow.unhealthy != null && hRow.unhealthy > 0 ? DANGER : ''}`} title="UnHealthyHostCount — >0이면 헬스체크 실패 원인 조사">
                    {hRow.unhealthy == null ? dash : Math.round(hRow.unhealthy)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
