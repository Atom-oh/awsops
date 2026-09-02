'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';

// 'IAM Roles with S3 Access' (gap L242, v1 parity): roles whose SYNCED attached managed
// policies include an S3-scoped policy or AdministratorAccess, max 30 (v1's cap). Reads the
// EXISTING /api/inventory/iam_role route (no new route; the same authenticated user can
// already read those rows). Honest bounds: a fetch failure renders an error line, and roles
// synced BEFORE attached_policy_arns joined the sync render an explicit "not synced yet"
// state — never an empty "no roles have access" claim. Named export per the metrics-module
// convention.

const MAX_ROLES = 30;
const S3_POLICY_RE = /(:policy\/(AmazonS3[A-Za-z]*|AdministratorAccess))$/;

type RoleHit = { name: string; policies: string[] };

export function s3AccessRoles(rows: Record<string, unknown>[]): { hits: RoleHit[]; anySynced: boolean } {
  const hits: RoleHit[] = [];
  let anySynced = false;
  for (const r of rows) {
    const arns = Array.isArray(r.attached_policy_arns) ? r.attached_policy_arns.map(String) : null;
    if (arns === null) continue; // column not synced on this row
    anySynced = true;
    const matched = arns.filter((a) => S3_POLICY_RE.test(a));
    if (matched.length) hits.push({ name: String(r.resource_id ?? r.name ?? ''), policies: matched.map((a) => a.split('/').pop() ?? a) });
  }
  return { hits: hits.slice(0, MAX_ROLES), anySynced };
}

export function S3IamAccessSection() {
  const { tt } = useI18n();
  const [state, setState] = useState<{ loading: boolean; err: boolean; hits: RoleHit[]; anySynced: boolean }>({
    loading: true, err: false, hits: [], anySynced: false,
  });

  useEffect(() => {
    let alive = true;
    fetch('/api/inventory/iam_role?limit=500')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        const rows = ((d.rows ?? []) as { resource_id: string; data?: Record<string, unknown> }[])
          .map((x) => ({ resource_id: x.resource_id, ...(x.data ?? {}) }));
        setState({ loading: false, err: false, ...s3AccessRoles(rows) });
      })
      .catch(() => { if (alive) setState({ loading: false, err: true, hits: [], anySynced: false }); });
    return () => { alive = false; };
  }, []);

  const heading = (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
      {tt('S3 접근 권한 보유 IAM Role')}
    </div>
  );
  if (state.loading) return <>{heading}<p className="text-[12px] text-ink-400">{tt('로딩 중…')}</p></>;
  if (state.err) return <>{heading}<p className="text-[12px] text-amber-700">{tt('IAM Role 목록을 불러오지 못했습니다.')}</p></>;
  if (!state.anySynced) {
    return <>{heading}<p className="text-[12px] text-ink-400">{tt('연결 정책 목록이 아직 동기화되지 않았습니다 — 다음 sync 이후 표시됩니다.')}</p></>;
  }
  if (state.hits.length === 0) {
    return <>{heading}<p className="text-[12px] text-ink-400">{tt('S3 관리형 정책(AmazonS3*/AdministratorAccess)이 연결된 role이 없습니다.')}</p></>;
  }
  return (
    <>
      {heading}
      <ul className="flex flex-col gap-1">
        {state.hits.map((h) => (
          <li key={h.name} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="min-w-0 truncate font-mono text-ink-700">{h.name}</span>
            <span className="shrink-0 text-[10.5px] text-ink-400">{h.policies.join(' · ')}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10.5px] text-ink-400">{tt('관리형 정책 기준 (인라인 정책·버킷 정책 경유 접근은 미포함) · 최대 30개')}</p>
    </>
  );
}

export default S3IamAccessSection;
