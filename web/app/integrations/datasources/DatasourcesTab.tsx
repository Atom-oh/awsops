'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import IntegrationIcon from '@/components/datasources/IntegrationIcon';
import StatTile from '@/components/ui/StatTile';
import { RefreshCw } from 'lucide-react';
import DatasourceForm, { type DatasourceFormValue } from './DatasourceForm';
import { useI18n } from '@/components/shell/LanguageProvider';

interface Instance {
  id: number; name: string; kind: string; endpoint?: string | null; authType?: string | null; isDefault?: boolean; connected?: boolean; enabled?: boolean; settings?: { timeoutS?: number; database?: string };
}

// Chat section per datasource kind (the deep-link prompt pins it with a leading /section —
// free-text routing would misroute: '연결' matches the network rule, and jaeger/datadog/dynatrace
// have no default-enabled connector target, so those kinds get no link at all).
const DIAGNOSE_SECTION: Record<string, string> = {
  prometheus: 'observability', clickhouse: 'observability',
  loki: 'monitoring', mimir: 'monitoring', tempo: 'monitoring',
};

// The Datasources tab: manage instances (multi-per-type, named) + drill into Explore. Read-visible to
// all authenticated users; mutating actions are admin-only (canManage).
export default function DatasourcesTab({ canManage = false }: { canManage?: boolean }) {
  const { tt } = useI18n();
  const [list, setList] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<null | { mode: 'add' } | { mode: 'edit'; value: DatasourceFormValue }>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/datasources');
      const body = await r.json();
      if (!r.ok || body.available === false) throw new Error('unavailable');
      setList(body.datasources ?? []);
      setUnavailable(false);
      setError('');
    } catch { setUnavailable(true); setError('데이터소스 설정을 불러오지 못했습니다. 새로고침하거나 관리자에게 확인하세요.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onDelete = async (i: Instance) => {
    if (typeof window !== 'undefined' && !window.confirm(tt(`"${i.name}" 데이터소스를 삭제할까요?`))) return;
    setBusyId(i.id);
    setError('');
    try {
      const r = await fetch(`/api/datasources/${i.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed');
      await load();
    } catch { setError('삭제하지 못했습니다. 권한과 연결 상태를 확인하고 다시 시도하세요.'); }
    finally { setBusyId(null); }
  };
  const onSetDefault = async (i: Instance) => {
    setBusyId(i.id);
    setError('');
    try {
      const r = await fetch(`/api/datasources/${i.id}/default`, { method: 'POST' });
      if (!r.ok) throw new Error('default failed');
      await load();
    } catch { setError('기본 데이터소스를 변경하지 못했습니다. 다시 시도하세요.'); }
    finally { setBusyId(null); }
  };

  if (form && canManage) {
    return (
      <Card className="p-4 max-w-xl">
        <DatasourceForm
          initial={form.mode === 'edit' ? form.value : undefined}
          onSaved={() => { setForm(null); load(); }}
          onCancel={() => setForm(null)}
        />
      </Card>
    );
  }

  // gap-audit L201: KPI roll-up from the already-fetched list — no extra API call.
  const connectedN = list.filter((i) => i.connected).length;
  const kindN = new Set(list.map((i) => i.kind)).size;
  // Defaults are PER KIND — one arbitrary name would misrepresent the set, so show the count
  // (with every kind: name pair in a tooltip) once there's more than one.
  const defaults = list.filter((i) => i.isDefault);
  const defaultVal = defaults.length === 0 ? '—'
    : defaults.length === 1 ? `★ ${defaults[0].name}` : `★ ${defaults.length}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-ink-500">{tt('관측성 데이터소스에서 메트릭·로그·트레이스를 조회합니다. Datadog·Dynatrace를 포함해 같은 타입을 여러 개 등록할 수 있습니다.')}</p>
        <div className="flex items-center gap-2">
          {/* gap-audit L202: re-fetch without a full page reload. */}
          <button
            type="button"
            aria-label={tt('새로고침')}
            title={tt('새로고침')}
            onClick={() => load()}
            disabled={loading}
            className="rounded-md border border-ink-200 bg-card p-1.5 text-ink-500 hover:bg-ink-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
          </button>
          {canManage && <Button onClick={() => setForm({ mode: 'add' })}>＋ {tt('데이터소스 추가')}</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-[13px] text-rose-600">{tt(error)}</p>}
      <p className="text-[12px] text-ink-500">{tt('설정 저장은 접속 확인을 의미하지 않습니다. 편집 화면에서 연결 테스트 후 탐색으로 실제 데이터를 확인하세요.')}</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label={tt('총 데이터소스')} value={unavailable ? '—' : list.length} />
        <StatTile label={tt('설정 저장됨')} value={unavailable ? '—' : connectedN} />
        <StatTile label={tt('타입 종류')} value={unavailable ? '—' : kindN} />
        <div title={defaults.map((d) => `${d.kind}: ${d.name}`).join(', ')}>
          <StatTile label={tt('기본 데이터소스')} value={unavailable ? '—' : defaultVal} />
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400 border-b border-ink-100">
              <th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th>{canManage && <th className="px-3 py-2">URL</th>}<th className="px-3 py-2">Auth</th>
              <th className="px-3 py-2">Status</th><th className="px-3 py-2">Default</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-400">{tt('불러오는 중…')}</td></tr>}
            {!loading && !unavailable && list.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-400">{tt('등록된 데이터소스가 없습니다.')}</td></tr>
            )}
            {list.map((i) => (
              <tr key={i.id} className="border-b border-ink-50">
                <td className="px-3 py-2 font-medium text-ink-800">
                  <span className="inline-flex items-center gap-2"><IntegrationIcon kind={i.kind} /> {i.name}</span>
                </td>
                <td className="px-3 py-2 text-ink-600">{i.kind}</td>
                {canManage && (
                  <td className="px-3 py-2">
                    <span className="block max-w-[260px] truncate font-mono text-[11px] text-ink-500" title={i.endpoint ?? ''}>{i.endpoint ?? '—'}</span>
                  </td>
                )}
                <td className="px-3 py-2 text-ink-500">{i.authType ?? 'none'}</td>
                <td className="px-3 py-2">
                  <span className="text-ink-500">{unavailable ? tt('상태 확인 불가') : i.enabled === false ? tt('비활성') : i.connected ? tt('설정 저장됨 · 미검증') : tt('인증 설정 필요')}</span>
                </td>
                <td className="px-3 py-2">{i.isDefault ? <span className="text-amber-600">{tt('★ 기본')}</span> : (canManage && <button className="text-[12px] text-brand-600 hover:underline" onClick={() => onSetDefault(i)} disabled={busyId === i.id}>{tt('기본으로 설정')}</button>)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {/* The chat gateway path resolves each kind's DEFAULT instance (kind-mirror
                      credential) — a non-default row's diagnosis would confidently describe the
                      WRONG datasource under this row's name. Scope the link to defaults until
                      the tool path is instance-aware. */}
                  {!unavailable && i.enabled !== false && i.isDefault && i.connected && DIAGNOSE_SECTION[i.kind] && (
                    <Link
                      href={`/assistant?q=${encodeURIComponent(`/${DIAGNOSE_SECTION[i.kind]} ${i.name} (${i.kind}) 데이터소스 상태를 진단해줘`)}`}
                      className="text-[12px] text-purple-600 hover:underline mr-3"
                    >
                      {tt('AI로 진단')}
                    </Link>
                  )}
                  <Link href={`/integrations/datasources/${i.id}`} className="text-[12px] text-brand-600 hover:underline mr-3">{tt('탐색')} →</Link>
                  {canManage && <button className="text-[12px] text-ink-600 hover:underline mr-3" onClick={() => setForm({ mode: 'edit', value: { id: i.id, name: i.name, kind: i.kind, endpoint: i.endpoint ?? '', authType: i.authType ?? 'none', settings: i.settings } })}>{tt('편집')}</button>}
                  {canManage && <button className="text-[12px] text-rose-600 hover:underline" onClick={() => onDelete(i)} disabled={busyId === i.id}>{tt('삭제')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
